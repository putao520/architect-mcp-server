#!/usr/bin/env node
// UV_THREADPOOL_SIZE must be set before any libuv work (including imports that trigger fs/net)
process.env.UV_THREADPOOL_SIZE = process.env.UV_THREADPOOL_SIZE || '8';

// rwkv-server.mjs — WebSocket RWKV 推理服务
// 架构：WebSocket 长连接 + SessionManager（GPU pool slot 管理 + LRU 保护） + 流式 token 输出
// 所有工具调用走 WS 协议，保留 /health GET 用于存活检查

import http from 'http';
import { WebSocketServer } from 'ws';
import { join, dirname, resolve, relative } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, readFileSync, writeFileSync, statSync, readdirSync, mkdirSync } from 'fs';
import { createHash, randomUUID } from 'crypto';
import { homedir } from 'os';
import { RwkvSession } from './rwkv-binding.mjs';

const HOME = homedir();

const __dirname = dirname(fileURLToPath(import.meta.url));

// === 模型加载（单例） ===

let model = null;
let tokenizer = null;
let modelHealth = { loadTime: 0, errorCount: 0, lastError: null, totalRequests: 0 };

const MODEL_PATHS = [
  process.env.RWKV_MODEL_PATH,
  join(__dirname, '../../rwkv.cpp/models/rwkv7-g1f-2.9b-Q8_0.bin'),
  join(__dirname, '../../rwkv.cpp/models/rwkv7-g1f-2.9b-FP16.bin'),
];
const VOCAB_PATH = join(__dirname, 'rwkv_vocab_v20230424.txt');

function findModel() {
  for (const p of MODEL_PATHS) {
    if (p && existsSync(p)) return p;
  }
  return null;
}

async function loadModel() {
  if (model) return;
  const { RwkvModel, RwkvTokenizer } = await import('./rwkv-binding.mjs');
  const modelPath = findModel();
  if (!modelPath) throw new Error('No RWKV model found');

  const gpuLayers = parseInt(process.env.RWKV_GPU_LAYERS || '32', 10);
  const threads = parseInt(process.env.RWKV_THREADS || '4', 10);
  const poolMaxSlots = parseInt(process.env.RWKV_POOL_SLOTS || '8', 10);

  model = new RwkvModel(modelPath, { threads, gpuLayers, poolMaxSlots });
  tokenizer = new RwkvTokenizer(VOCAB_PATH);
  modelHealth.loadTime = Date.now();
}

// === WS 发送辅助 ===

function wsSend(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

// === 文件读取 ===

function readFilesAsContext(files, cwd, maxFileBytes = 100_000_000) {
  const parts = [];
  for (const f of files) {
    const abs = resolve(cwd || process.cwd(), f);
    if (!existsSync(abs)) { parts.push(`[${f}] FILE NOT FOUND`); continue; }
    const st = statSync(abs);
    if (st.isDirectory()) {
      for (const entry of walkDir(abs, maxFileBytes)) parts.push(entry);
    } else {
      parts.push(readOneFile(f, abs, maxFileBytes));
    }
  }
  return parts.join('\n\n');
}

function walkDir(dir, maxFileBytes = 200_000) {
  const results = [];
  try {
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      if (name.name.startsWith('.') || name.name === 'node_modules') continue;
      const full = join(dir, name.name);
      if (name.isDirectory()) results.push(...walkDir(full, maxFileBytes));
      else results.push(readOneFile(name.name, full, maxFileBytes));
    }
  } catch {}
  return results;
}

function readOneFile(displayPath, absPath, maxBytes = 200_000) {
  try {
    const buf = readFileSync(absPath);
    if (buf.length > maxBytes) return `[${displayPath}] (${(buf.length / 1024).toFixed(0)}KB, showing first ${(maxBytes / 1024).toFixed(0)}KB)\n${buf.subarray(0, maxBytes).toString('utf-8')}`;
    return `[${displayPath}]\n${buf.toString('utf-8')}`;
  } catch (e) {
    return `[${displayPath}] READ ERROR: ${e.message}`;
  }
}

// === SessionManager — GPU pool slot 管理 + LRU 保护 ===

class SessionManager {
  #sessions = new Map();
  #model;
  #tokenizer;

  constructor(model, tokenizer) {
    this.#model = model;
    this.#tokenizer = tokenizer;
  }

  /** 创建新 session（异步，排队等 GPU slot） */
  async create() {
    const session = await RwkvSession.create(this.#model, this.#tokenizer);
    const id = randomUUID();
    this.#sessions.set(id, { session, lastUsed: Date.now(), pinned: false });
    return { id, session };
  }

  get(id) {
    const entry = this.#sessions.get(id);
    if (!entry) return null;
    entry.lastUsed = Date.now();
    return entry.session;
  }

  destroy(id) {
    const entry = this.#sessions.get(id);
    if (!entry) { return; }
    entry.session.destroy();
    this.#sessions.delete(id);
  }

  /** Abort all active sessions (used on WS close to cancel running tool handlers) */
  abortAll() {
    for (const [, entry] of this.#sessions) {
      entry.session.abort();
    }
  }

  pin(id) {
    const entry = this.#sessions.get(id);
    if (entry) entry.pinned = true;
  }

  unpin(id) {
    const entry = this.#sessions.get(id);
    if (entry) entry.pinned = false;
  }

  get size() { return this.#sessions.size; }

  /** Destroy all sessions (emergency cleanup on WS close) */
  destroyAll() {
    for (const id of [...this.#sessions.keys()]) this.destroy(id);
  }

  destroyAll() {
    for (const id of [...this.#sessions.keys()]) this.destroy(id);
  }
}

let sessionManager = null;

// === 流式生成辅助 ===

const GEN_OPTS = { alphaPresence: 2.0, alphaFrequency: 0.1, alphaDecay: 0.99 };
const DEEP_THINK = { ...GEN_OPTS, maxRounds: 3, maxThinkTokens: 2048, maxAnswerTokens: 4096 };

function nlTokenId() {
  return tokenizer.encode('\n')[0];
}

async function streamGenerate(session, maxTokens, opts, ws, requestId) {
  const tokens = [];
  for (let i = 0; i < maxTokens; i++) {
    if (session.isAborted) break;
    const tid = await session.generateToken(opts);
    tokens.push(tid);
    wsSend(ws, { requestId, type: 'token', text: tokenizer.decode([tid]), tokenId: tid, index: i });
  }
  return tokenizer.decode(tokens);
}

async function streamThinkGenerate(session, maxAnswerTokens, opts, ws, requestId) {
  const { maxThinkTokens = 4096, ...genOpts } = opts;
  const nlId = nlTokenId();

  const thinkTokens = [];
  for (let i = 0; i < maxThinkTokens; i++) {
    if (session.isAborted) break;
    const tid = await session.generateToken(genOpts);
    thinkTokens.push(tid);
    if (tid === nlId) break;
  }
  const thinking = tokenizer.decode(thinkTokens).replace(/\n$/, '');

  const answerTokens = [];
  for (let i = 0; i < maxAnswerTokens; i++) {
    if (session.isAborted) break;
    const tid = await session.generateToken(genOpts);
    answerTokens.push(tid);
    wsSend(ws, { requestId, type: 'token', text: tokenizer.decode([tid]), tokenId: tid, index: i });
  }
  const answer = tokenizer.decode(answerTokens);
  return { thinking, answer };
}

async function streamMultiRoundThink(session, prompt, opts, ws, requestId) {
  const { maxRounds = 5, maxThinkTokens = 2048, maxAnswerTokens = 2048, systemPrompt, history = [], ...genOpts } = opts;
  const nlId = nlTokenId();
  const rounds = [];
  let converged = false;

  await session.feedChatPrompt(prompt, { systemPrompt, history, think: true });

  for (let round = 0; round < maxRounds; round++) {
    if (session.isAborted) break;

    const thinkTokens = [];
    for (let i = 0; i < maxThinkTokens; i++) {
      if (session.isAborted) break;
      const tid = await session.generateToken(genOpts);
      thinkTokens.push(tid);
      if (tid === nlId) break;
    }
    const thinking = tokenizer.decode(thinkTokens).replace(/\n$/, '');

    const answerTokens = [];
    for (let i = 0; i < maxAnswerTokens; i++) {
      if (session.isAborted) break;
      const tid = await session.generateToken(genOpts);
      answerTokens.push(tid);
      wsSend(ws, { requestId, type: 'token', text: tokenizer.decode([tid]), tokenId: tid, round, index: i });
    }
    const answer = tokenizer.decode(answerTokens);
    rounds.push({ thinking, answer });

    if (rounds.length >= 2) {
      const prev = rounds[rounds.length - 2].thinking;
      const curr = rounds[rounds.length - 1].thinking;
      if (curr.trim() === prev.trim()) { converged = true; break; }
      if (curr.length < prev.length * 0.2 && curr.length < 50) { converged = true; break; }
    }

    if (round < maxRounds - 1 && !converged) {
      await session.feedPrompt(`\nUser: Continue reasoning. Go deeper into the analysis.\nAssistant:\n`);
    }
  }

  return {
    rounds,
    totalRounds: rounds.length,
    converged,
    finalAnswer: rounds[rounds.length - 1].answer,
    allThinking: rounds.map(r => r.thinking).join('\n---\n'),
  };
}

// === DAG 执行引擎 ===

function topoSortLevels(nodes, deps) {
  const nodeMap = new Map(nodes.map(n => [n.id, n]));
  const inDeg = new Map(nodes.map(n => [n.id, 0]));
  const children = new Map(nodes.map(n => [n.id, []]));

  for (const { from, to } of deps) {
    inDeg.set(to, (inDeg.get(to) || 0) + 1);
    children.get(from)?.push(to);
  }

  const levels = [];
  let queue = nodes.filter(n => (inDeg.get(n.id) || 0) === 0).map(n => n.id);
  const visited = new Set();

  while (queue.length > 0) {
    levels.push(queue.map(id => nodeMap.get(id)));
    for (const id of queue) visited.add(id);
    const next = [];
    for (const id of queue) {
      for (const child of (children.get(id) || [])) {
        inDeg.set(child, (inDeg.get(child) || 0) - 1);
        if (inDeg.get(child) === 0 && !visited.has(child)) next.push(child);
      }
    }
    queue = next;
  }

  const orphan = nodes.filter(n => !visited.has(n.id));
  if (orphan.length) levels.unshift(orphan);

  return levels;
}

const NODE_PROMPTS = {
  abstract: 'Analyze this at the highest level of abstraction. Identify the core patterns, hidden relationships, and architectural principles. Think beyond surface details.',
  decompose: 'Decompose this into independent sub-problems. Identify dependencies between them, the critical path, and opportunities for parallel resolution.',
  dataflow: 'Trace the complete data flow. Where does data originate, what transforms it, where does it end up? Identify branching points, feedback loops, and cross-boundary contracts.',
  risk: 'Assess systemic risks: security vulnerabilities, performance bottlenecks, reliability weak points, scalability limits, and maintainability concerns.',
  structure: 'Map the architectural structure: module boundaries, abstraction layers, dependency graph, and key design decisions. Focus on the overall shape, not individual components.',
};

async function executeDAG(args, ws, requestId) {
  const { problem, files, context, nodes, deps, cwd } = args;
  const fileContext = files?.length ? readFilesAsContext(files, cwd) : '';

  const { id: baseId, session: baseSession } = await sessionManager.create();
  sessionManager.pin(baseId);
  try {
    const userContent = [
      problem,
      fileContext ? `Context Files:\n${fileContext}` : '',
      context ? `Additional Context:\n${context}` : '',
    ].filter(Boolean).join('\n\n');

    await baseSession.feedChatPrompt(userContent, {
      systemPrompt: 'You are an abstract reasoning engine. Analyze at the highest level of abstraction. Identify core patterns, hidden relationships, and architectural principles.',
    });
    const baseState = await baseSession.exportState();

    const levels = topoSortLevels(nodes, deps);
    const results = {};
    const nodeMap = new Map(nodes.map(n => [n.id, n]));

    for (const level of levels) {
      for (const node of level) {
        const { id: nodeId, session: nodeSession } = await sessionManager.create();
        sessionManager.pin(nodeId);
        try {
          await nodeSession.importState(baseState);

          const parentIds = (deps || []).filter(d => d.to === node.id).map(d => d.from);
          const parentPart = parentIds.length > 0
            ? parentIds.map(pid => `Result from [${pid}]:\n${results[pid] || '(no result)'}`).join('\n\n') + '\n\n'
            : '';

          const nodeQuery = `${NODE_PROMPTS[node.type || 'abstract']}\n\nTask [${node.id}]: ${node.query}\n${parentPart}`;
          await nodeSession.feedChatPrompt(nodeQuery, { think: true });
          const { answer } = await streamThinkGenerate(nodeSession, 2048, GEN_OPTS, ws, requestId);
          results[node.id] = answer;
        } finally {
          sessionManager.unpin(nodeId);
          sessionManager.destroy(nodeId);
        }
      }
    }

    const { id: synthId, session: synthSession } = await sessionManager.create();
    sessionManager.pin(synthId);
    try {
      await synthSession.importState(baseState);
      const allResults = Object.entries(results)
        .map(([id, text]) => `[${id}]: ${text}`)
        .join('\n\n---\n\n');

      const synthResult = await streamMultiRoundThink(
        synthSession,
        `All reasoning results:\n${allResults}\n\nNow synthesize all results into a unified, high-level conclusion. Identify cross-cutting themes, contradictions, and the overall architectural insight. Be abstract and conceptual.`,
        DEEP_THINK, ws, requestId
      );
      const synthesis = synthResult.finalAnswer;

      const out = [`ABSTRACT REASONING COMPLETE`];
      out.push(`Nodes: ${nodes.length} | Levels: ${levels.length} | Engine: RWKV-7 G1 (Think mode)`);

      for (const [id, text] of Object.entries(results)) {
        const node = nodeMap.get(id);
        out.push(`\n## [${id}] (${node?.type || 'abstract'})`);
        out.push(text);
      }

      out.push('\n## Synthesis');
      out.push(synthesis);

      return { content: [{ type: 'text', text: out.join('\n') }] };
    } finally {
      sessionManager.unpin(synthId);
      sessionManager.destroy(synthId);
    }
  } finally {
    sessionManager.unpin(baseId);
    sessionManager.destroy(baseId);
  }
}

// === Deep Read ===

const DEEP_READ_MODES = {
  extract: 'Extract specific information from the context above to answer the question. Be precise, include relevant details and exact references.',
  summarize: 'Provide a comprehensive summary of the context above. Focus on key entities, relationships, decisions, and conclusions.',
  analyze: 'Analyze the context above in depth. Identify patterns, hidden relationships, architectural decisions, potential issues, and underlying principles.',
  qa: 'Answer the question based on the context above. If the answer cannot be found, explicitly state what is missing.',
};

async function deepRead(args, ws, requestId) {
  const { files, question, mode = 'qa', cwd } = args;
  const content = readFilesAsContext(files, cwd, 100_000_000);
  if (!content.trim()) {
    return { content: [{ type: 'text', text: 'DEEP READ: No content found in specified files.' }] };
  }

  const modePrompt = DEEP_READ_MODES[mode] || DEEP_READ_MODES.qa;
  const fileSizeKB = (content.length / 1024).toFixed(0);

  const { id: sid, session } = await sessionManager.create();
  sessionManager.pin(sid);
  try {
    // RWKV 线性注意力：固定 20.63MB state，全文直接 feed，无上下文窗口限制
    await session.feedPrompt(content);
    let answer;
    if (mode === 'analyze') {
      const mr = await streamMultiRoundThink(session, `${modePrompt}\n\nQuestion: ${question.replace(/\n\n/g, '\n')}`, DEEP_THINK, ws, requestId);
      answer = mr.finalAnswer;
    } else {
      await session.feedPrompt(`\n\nUser: ${modePrompt}\n\nQuestion: ${question.replace(/\n\n/g, '\n')}\nAssistant:\n`);
      answer = await streamGenerate(session, 2048, GEN_OPTS, ws, requestId);
    }
    return { content: [{ type: 'text', text: `DEEP READ COMPLETE\nMode: ${mode} | Input: ${fileSizeKB}KB (full context, no truncation)\n\n## Answer\n${answer}` }] };
  } finally {
    sessionManager.unpin(sid);
    sessionManager.destroy(sid);
  }
}

// === Project Memory ===

const STATES_DIR = join(homedir(), '.rwkv-states');
const DEFAULT_EXCLUDE = ['.git', 'node_modules', '__pycache__', '.DS_Store', 'target', 'dist', 'build', '.cache', '.claude', 'venv', '.venv'];

function ensureDir(dir) { if (!existsSync(dir)) mkdirSync(dir, { recursive: true }); }

function fileChecksum(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex').slice(0, 16);
}

function scanProject(rootPath, exclude = []) {
  const skip = new Set([...DEFAULT_EXCLUDE, ...exclude]);
  const files = [];
  (function walk(dir) {
    try {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (skip.has(e.name) || e.name.startsWith('.')) continue;
        const full = join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (statSync(full).size <= 10_000_000) files.push(full);
      }
    } catch {}
  })(rootPath);
  return files;
}

function saveProjectState(project, state, meta, summary) {
  const dir = join(STATES_DIR, project);
  ensureDir(dir);
  writeFileSync(join(dir, 'state.bin'), Buffer.from(state.buffer, state.byteOffset, state.byteLength * 4));
  writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
  writeFileSync(join(dir, 'summary.md'), summary);
}

function loadProjectState(project) {
  const dir = join(STATES_DIR, project);
  if (!existsSync(join(dir, 'state.bin'))) return null;
  const raw = readFileSync(join(dir, 'state.bin'));
  const state = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
  const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf-8'));
  return { state, meta };
}

async function projectSave(args, ws, requestId) {
  const { project, path: rootPath, exclude = [], watch } = args;
  const effectiveProject = watch ? `watch-${project}` : project;
  const files = scanProject(rootPath, exclude);
  if (!files.length) return { content: [{ type: 'text', text: 'PROJECT SAVE: No files found.' }] };

  const checksums = {};
  for (const f of files) checksums[relative(rootPath, f)] = fileChecksum(f);

  // L3: File-level summaries
  const l3Summaries = {};
  for (const f of files) {
    const rel = relative(rootPath, f);
    const content = readOneFile(rel, f, 100_000_000);
    const { id: sid, session } = await sessionManager.create();
    try {
      await session.feedPrompt(content);
      await session.feedPrompt('\n\nUser: Summarize this file in 2-3 sentences: purpose, key exports, main logic.\nAssistant:\n');
      l3Summaries[rel] = await streamGenerate(session, 256, GEN_OPTS, ws, requestId);
    } finally {
      sessionManager.destroy(sid);
    }
  }

  // L2: Module-level summaries
  const dirs = {};
  for (const rel of Object.keys(l3Summaries)) {
    const dir = dirname(rel);
    if (!dirs[dir]) dirs[dir] = [];
    dirs[dir].push(l3Summaries[rel]);
  }
  const l2Summaries = {};
  for (const [dir, fileSums] of Object.entries(dirs)) {
    const { id: sid, session } = await sessionManager.create();
    try {
      await session.feedPrompt(`Module [${dir}] contains these files:\n${fileSums.map((sum) => `- ${sum}`).join('\n')}`);
      await session.feedPrompt('\n\nUser: Summarize this module: purpose, responsibilities, key interfaces.\nAssistant:\n');
      l2Summaries[dir] = await streamGenerate(session, 256, GEN_OPTS, ws, requestId);
    } finally {
      sessionManager.destroy(sid);
    }
  }

  // L1: Project overview
  const allL2 = Object.entries(l2Summaries).map(([dir, sum]) => `[${dir}]: ${sum}`).join('\n');
  const { id: l1Id, session: l1Session } = await sessionManager.create();
  try {
    await l1Session.feedPrompt(`Project modules:\n${allL2}`);
    await l1Session.feedPrompt('\n\nUser: Describe the overall project architecture in 3-5 sentences: what it does, how it\'s organized, key design decisions.\nAssistant:\n');
    const l1 = await streamGenerate(l1Session, 256, GEN_OPTS, ws, requestId);

    // Full state: feed all files
    const { id: fullId, session: fullSession } = await sessionManager.create();
    sessionManager.pin(fullId);
    try {
      const CHUNK = 262144;
      for (const f of files) {
        const content = readOneFile(relative(rootPath, f), f, 100_000_000);
        for (let i = 0; i < content.length; i += CHUNK) {
          let end = Math.min(i + CHUNK, content.length);
          if (end < content.length) { const nl = content.lastIndexOf('\n', end); if (nl > i) end = nl + 1; }
          await fullSession.feedPrompt(content.slice(i, end));
        }
      }
      const state = await fullSession.exportState();

      const summary = `# ${project}\n\n## Overview (L1)\n${l1}\n\n## Modules (L2)\n${Object.entries(l2Summaries).map(([d, s]) => `### ${d}\n${s}`).join('\n\n')}\n\n## Files (L3)\n${Object.entries(l3Summaries).map(([f, s]) => `### ${f}\n${s}`).join('\n\n')}\n`;
      const meta = { project: effectiveProject, path: rootPath, files: Object.keys(checksums), checksums, fileCount: files.length, watch: !!watch, createdAt: Date.now(), updatedAt: Date.now() };
      saveProjectState(effectiveProject, state, meta, summary);

      const label = watch ? `WATCH BASELINE: ${project}` : `PROJECT SAVED: ${project}`;
      return { content: [{ type: 'text', text: `${label}\nFiles: ${files.length} | Modules: ${Object.keys(l2Summaries).length}\n\n## Overview\n${l1}` }] };
    } finally {
      sessionManager.unpin(fullId);
      sessionManager.destroy(fullId);
    }
  } finally {
    sessionManager.destroy(l1Id);
  }
}

async function projectQuery(args, ws, requestId) {
  const loaded = loadProjectState(args.project);
  if (!loaded) return { content: [{ type: 'text', text: `PROJECT QUERY: "${args.project}" not found. Use project_save first.` }] };

  const { id: sid, session } = await sessionManager.create();
  sessionManager.pin(sid);
  try {
    await session.importState(loaded.state);
    const mr = await streamMultiRoundThink(session, args.question.replace(/\n\n/g, '\n'), DEEP_THINK, ws, requestId);
    return { content: [{ type: 'text', text: `PROJECT QUERY: ${args.project}\nRounds: ${mr.totalRounds} | Converged: ${mr.converged}\n\n## Answer\n${mr.finalAnswer}` }] };
  } finally {
    sessionManager.unpin(sid);
    sessionManager.destroy(sid);
  }
}

function projectList() {
  if (!existsSync(STATES_DIR)) return { content: [{ type: 'text', text: 'No saved projects.' }] };
  const projects = readdirSync(STATES_DIR, { withFileTypes: true }).filter(d => d.isDirectory());
  if (!projects.length) return { content: [{ type: 'text', text: 'No saved projects.' }] };

  const lines = [];
  for (const p of projects) {
    try {
      const meta = JSON.parse(readFileSync(join(STATES_DIR, p.name, 'meta.json'), 'utf-8'));
      const age = ((Date.now() - meta.updatedAt) / 60000).toFixed(0);
      lines.push(`- ${p.name}: ${meta.fileCount} files, ${meta.path} (updated ${age}min ago)`);
    } catch { lines.push(`- ${p.name}: (metadata corrupted)`); }
  }
  return { content: [{ type: 'text', text: `Saved Projects:\n${lines.join('\n')}` }] };
}

// === Multi Lens ===

const LENS_PROMPTS = {
  security: 'Analyze from a SECURITY perspective: vulnerabilities, attack surfaces, auth issues, data exposure, OWASP risks.',
  performance: 'Analyze from a PERFORMANCE perspective: bottlenecks, latency, throughput, memory usage, scaling limits.',
  maintainability: 'Analyze from a MAINTAINABILITY perspective: code clarity, complexity, testability, documentation, tech debt.',
  architecture: 'Analyze from an ARCHITECTURE perspective: module boundaries, coupling, cohesion, patterns, extensibility.',
  reliability: 'Analyze from a RELIABILITY perspective: error handling, fault tolerance, recovery, monitoring, edge cases.',
};

async function multiLens(args, ws, requestId) {
  const { files, question, lenses = ['security', 'performance', 'architecture'], extraLens, cwd } = args;
  const content = readFilesAsContext(files, cwd, 100_000_000);

  const { id: baseId, session: baseSession } = await sessionManager.create();
  sessionManager.pin(baseId);
  try {
    await baseSession.feedPrompt(content);
    const baseState = await baseSession.exportState();

    const perspectives = [];
    for (const lens of lenses) {
      const { id: lid, session } = await sessionManager.create();
      sessionManager.pin(lid);
      try {
        await session.importState(baseState);
        await session.feedPrompt(`\n\nUser: ${LENS_PROMPTS[lens] || lens}\n\nQuestion: ${question}\nAssistant:\n`);
        const { answer } = await streamThinkGenerate(session, 2048, GEN_OPTS, ws, requestId);
        perspectives.push({ lens, answer });
      } finally {
        sessionManager.unpin(lid);
        sessionManager.destroy(lid);
      }
    }

    if (extraLens) {
      const { id: lid, session } = await sessionManager.create();
      sessionManager.pin(lid);
      try {
        await session.importState(baseState);
        await session.feedPrompt(`\n\nUser: ${extraLens}\n\nQuestion: ${question}\nAssistant:\n`);
        perspectives.push({ lens: 'custom', answer: (await streamThinkGenerate(session, 2048, GEN_OPTS, ws, requestId)).answer });
      } finally {
        sessionManager.unpin(lid);
        sessionManager.destroy(lid);
      }
    }

    const { id: synthId, session: synthSession } = await sessionManager.create();
    sessionManager.pin(synthId);
    try {
      await synthSession.importState(baseState);
      const allPerspectives = perspectives.map(p => `[${p.lens}]: ${p.answer}`).join('\n\n');
      const synthResult = await streamMultiRoundThink(
        synthSession,
        `Cross-analyze these perspectives on "${question}":\n${allPerspectives}\n\nIdentify contradictions, trade-offs, and unified recommendations.`,
        DEEP_THINK, ws, requestId
      );

      const out = [`MULTI-LENS ANALYSIS`, `Lenses: ${perspectives.map(p => p.lens).join(', ')}`, ''];
      for (const p of perspectives) { out.push(`## ${p.lens}`); out.push(p.answer); out.push(''); }
      out.push('## Synthesis'); out.push(synthResult.finalAnswer);

      return { content: [{ type: 'text', text: out.join('\n') }] };
    } finally {
      sessionManager.unpin(synthId);
      sessionManager.destroy(synthId);
    }
  } finally {
    sessionManager.unpin(baseId);
    sessionManager.destroy(baseId);
  }
}

// === Diff Read ===

async function diffRead(args, ws, requestId) {
  const { filesA, filesB, question, labelA = 'A', labelB = 'B', cwd } = args;
  const contentA = readFilesAsContext(filesA, cwd, 100_000_000);
  const contentB = readFilesAsContext(filesB, cwd, 100_000_000);

  const { id: aId, session: sA } = await sessionManager.create();
  sessionManager.pin(aId);
  try {
    await sA.feedPrompt(contentA);
    await sA.feedPrompt('\n\nUser: Describe the structure, key components, and main logic of this codebase.\nAssistant:\n');
    const summaryA = await streamGenerate(sA, 1024, GEN_OPTS, ws, requestId);

    const { id: bId, session: sB } = await sessionManager.create();
    sessionManager.pin(bId);
    try {
      await sB.feedPrompt(contentB);
      await sB.feedPrompt('\n\nUser: Describe the structure, key components, and main logic of this codebase.\nAssistant:\n');
      const summaryB = await streamGenerate(sB, 1024, GEN_OPTS, ws, requestId);

      const { id: cId, session: sC } = await sessionManager.create();
      sessionManager.pin(cId);
      try {
        const diffResult = await streamMultiRoundThink(
          sC,
          `Compare these two versions:\n\n[${labelA}]:\n${summaryA}\n\n[${labelB}]:\n${summaryB}\n\nQuestion: ${question}`,
          DEEP_THINK, ws, requestId
        );

        return { content: [{ type: 'text', text: `DIFF ANALYSIS: ${labelA} vs ${labelB}\n\n## ${labelA} Summary\n${summaryA}\n\n## ${labelB} Summary\n${summaryB}\n\n## Diff: ${question}\n${diffResult.finalAnswer}` }] };
      } finally {
        sessionManager.unpin(cId);
        sessionManager.destroy(cId);
      }
    } finally {
      sessionManager.unpin(bId);
      sessionManager.destroy(bId);
    }
  } finally {
    sessionManager.unpin(aId);
    sessionManager.destroy(aId);
  }
}

// === Watch Check ===

const WATCH_MIN_INTERVAL = 10 * 60 * 1000;
let serverBusy = false;

async function watchCheck(args, ws, requestId) {
  const { project, question = 'Analyze the recent changes' } = args;
  const watchProject = `watch-${project}`;

  const loaded = loadProjectState(watchProject);
  if (!loaded) return { content: [{ type: 'text', text: `WATCH CHECK: "${project}" not set up. Use project_save with watch=true first.` }] };

  const elapsed = Date.now() - loaded.meta.updatedAt;
  const statusLine = `Files: ${loaded.meta.files.length} | Last check: ${(elapsed / 60000).toFixed(1)}min ago`;

  if (elapsed < WATCH_MIN_INTERVAL) {
    const remain = Math.ceil((WATCH_MIN_INTERVAL - elapsed) / 60000);
    return { content: [{ type: 'text', text: `WATCH STATUS: ${project}\n${statusLine} | Next available in: ${remain}min\n\nToo soon for analysis. Minimum 10min interval.` }] };
  }

  if (serverBusy) return { content: [{ type: 'text', text: `WATCH CHECK: Server busy, try later.\n${statusLine}` }] };

  serverBusy = true;
  try {
    const currentChecksums = {};
    const changedFiles = [];
    const newFiles = [];
    const rootPath = loaded.meta.path;

    for (const rel of loaded.meta.files) {
      const abs = join(rootPath, rel);
      if (!existsSync(abs)) { currentChecksums[rel] = null; continue; }
      currentChecksums[rel] = fileChecksum(abs);
      if (currentChecksums[rel] !== loaded.meta.checksums[rel]) changedFiles.push(rel);
    }

    const currentFiles = scanProject(rootPath);
    for (const f of currentFiles) {
      const rel = relative(rootPath, f);
      if (!loaded.meta.checksums[rel]) newFiles.push(rel);
    }

    const allChanged = [...changedFiles, ...newFiles];
    if (!allChanged.length) return { content: [{ type: 'text', text: 'WATCH CHECK: No changes detected.' }] };

    const { id: sid, session } = await sessionManager.create();
    sessionManager.pin(sid);
    try {
      await session.importState(loaded.state);
      const changeContent = allChanged.map(rel => {
        const abs = join(rootPath, rel);
        return readOneFile(rel, abs, 100_000_000);
      }).join('\n\n');

      await session.feedPrompt(`\n\nUpdated files:\n${changeContent}`);
      await session.feedPrompt(`\n\nUser: ${question}\n\nChanged files: ${allChanged.join(', ')}\nAssistant:\n`);
      const { answer } = await streamThinkGenerate(session, 4096, GEN_OPTS, ws, requestId);

      const newState = await session.exportState();
      loaded.meta.checksums = currentChecksums;
      loaded.meta.updatedAt = Date.now();
      saveProjectState(watchProject, newState, loaded.meta, `# Watch: ${project}\nLast check: ${new Date().toISOString()}\n`);

      return { content: [{ type: 'text', text: `WATCH CHECK: ${project}\nChanged: ${allChanged.length} files (${changedFiles.length} modified, ${newFiles.length} new)\n\n## Analysis\n${answer}` }] };
    } finally {
      sessionManager.unpin(sid);
      sessionManager.destroy(sid);
    }
  } finally {
    serverBusy = false;
  }
}

// === WS 消息路由 ===

const TOOL_MAP = {
  'execute-dag': executeDAG,
  'deep-read': deepRead,
  'project-save': projectSave,
  'project-query': projectQuery,
  'project-list': projectList,
  'multi-lens': multiLens,
  'diff-read': diffRead,
  'watch-check': watchCheck,
};

function handleConnection(ws) {
  const connectionSessions = new Set();

  ws.on('close', () => {
    model.abort();
    sessionManager.abortAll();
    // Repeatedly abort+destroy until all sessions cleaned up
    const cleanup = setInterval(() => {
      model.abort();
      sessionManager.abortAll();
      sessionManager.destroyAll();
      if (sessionManager.size === 0) {
        clearInterval(cleanup);
      }
    }, 500);
    setTimeout(() => clearInterval(cleanup), 30000);
  });

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { wsSend(ws, { type: 'error', message: 'Invalid JSON' }); return; }

    const { requestId, type } = msg;

    try {
      switch (type) {
        case 'session.create': {
          const { id } = await sessionManager.create();
          connectionSessions.add(id);
          wsSend(ws, { requestId, type: 'session.created', sessionId: id });
          break;
        }

        case 'session.feedPrompt': {
          const session = sessionManager.get(msg.sessionId);
          if (!session) { wsSend(ws, { requestId, type: 'error', message: `Session ${msg.sessionId} not found` }); break; }
          await session.feedPrompt(msg.text);
          wsSend(ws, { requestId, type: 'session.promptFed', sessionId: msg.sessionId });
          break;
        }

        case 'session.feedChatPrompt': {
          const session = sessionManager.get(msg.sessionId);
          if (!session) { wsSend(ws, { requestId, type: 'error', message: `Session ${msg.sessionId} not found` }); break; }
          await session.feedChatPrompt(msg.text, msg.options || {});
          wsSend(ws, { requestId, type: 'session.promptFed', sessionId: msg.sessionId });
          break;
        }

        case 'session.generate': {
          const session = sessionManager.get(msg.sessionId);
          if (!session) { wsSend(ws, { requestId, type: 'error', message: `Session ${msg.sessionId} not found` }); break; }
          const text = await streamGenerate(session, msg.maxTokens || 512, msg.options || {}, ws, requestId);
          wsSend(ws, { requestId, type: 'generate.done', sessionId: msg.sessionId, text, tokenCount: session.tokenCount });
          break;
        }

        case 'session.thinkGenerate': {
          const session = sessionManager.get(msg.sessionId);
          if (!session) { wsSend(ws, { requestId, type: 'error', message: `Session ${msg.sessionId} not found` }); break; }
          const result = await streamThinkGenerate(session, msg.maxAnswerTokens || 2048, msg.options || {}, ws, requestId);
          wsSend(ws, { requestId, type: 'thinkGenerate.done', sessionId: msg.sessionId, ...result });
          break;
        }

        case 'session.multiRoundThink': {
          const session = sessionManager.get(msg.sessionId);
          if (!session) { wsSend(ws, { requestId, type: 'error', message: `Session ${msg.sessionId} not found` }); break; }
          const mr = await streamMultiRoundThink(session, msg.prompt, msg.options || {}, ws, requestId);
          wsSend(ws, { requestId, type: 'multiRoundThink.done', sessionId: msg.sessionId, ...mr });
          break;
        }

        case 'session.exportState': {
          const session = sessionManager.get(msg.sessionId);
          if (!session) { wsSend(ws, { requestId, type: 'error', message: `Session ${msg.sessionId} not found` }); break; }
          const state = await session.exportState();
          const copy = new Float32Array(state);
          const buf = Buffer.from(copy.buffer, copy.byteOffset, copy.byteLength);
          wsSend(ws, { requestId, type: 'state.exported', sessionId: msg.sessionId, stateB64: buf.toString('base64') });
          break;
        }

        case 'session.importState': {
          const session = sessionManager.get(msg.sessionId);
          if (!session) { wsSend(ws, { requestId, type: 'error', message: `Session ${msg.sessionId} not found` }); break; }
          const buf = Buffer.from(msg.stateB64, 'base64');
          const state = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
          await session.importState(state);
          wsSend(ws, { requestId, type: 'state.imported', sessionId: msg.sessionId });
          break;
        }

        case 'session.pin': {
          sessionManager.pin(msg.sessionId);
          wsSend(ws, { requestId, type: 'session.pinned', sessionId: msg.sessionId });
          break;
        }

        case 'session.unpin': {
          sessionManager.unpin(msg.sessionId);
          wsSend(ws, { requestId, type: 'session.unpinned', sessionId: msg.sessionId });
          break;
        }

        case 'session.destroy': {
          sessionManager.unpin(msg.sessionId);
          sessionManager.destroy(msg.sessionId);
          connectionSessions.delete(msg.sessionId);
          wsSend(ws, { requestId, type: 'session.destroyed', sessionId: msg.sessionId });
          break;
        }

        case 'tool.execute': {
          modelHealth.totalRequests++;
          const handler = TOOL_MAP[msg.tool];
          if (!handler) { wsSend(ws, { requestId, type: 'error', message: `Unknown tool: ${msg.tool}` }); break; }
          const isNoArgs = msg.tool === 'project-list';
          const TOOL_TIMEOUT = parseInt(process.env.RWKV_TOOL_TIMEOUT || '1800000', 10);
          const result = await Promise.race([
            handler(isNoArgs ? {} : (msg.args || {}), ws, requestId),
            new Promise((_, reject) => setTimeout(() => reject(new Error(`Tool "${msg.tool}" execution timeout (${TOOL_TIMEOUT}ms)`)), TOOL_TIMEOUT)),
          ]);
          wsSend(ws, { requestId, type: 'tool.result', tool: msg.tool, ...result });
          break;
        }

        default:
          wsSend(ws, { requestId, type: 'error', message: `Unknown message type: ${type}` });
      }
    } catch (err) {
      modelHealth.errorCount++;
      modelHealth.lastError = { message: err.message, time: Date.now() };
      wsSend(ws, {
        requestId,
        type: 'error',
        message: `${err.message}\n${err.stack?.split('\n').slice(0, 5).join('\n')}`,
      });
    }
  });
}

// === 服务器启动 ===

const PORT = parseInt(process.env.RWKV_SERVER_PORT || '19876', 10);
const PID_FILE = join(homedir(), '.rwkv-server.json');

async function main() {
  console.error('[rwkv-server] Loading RWKV model...');
  await loadModel();
  sessionManager = new SessionManager(model, tokenizer);
  console.error('[rwkv-server] Model loaded. SessionManager ready.');

  const httpServer = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'GET' && req.url === '/health') {
      const uptime = modelHealth.loadTime ? ((Date.now() - modelHealth.loadTime) / 1000).toFixed(0) : '0';
      const memUsage = process.memoryUsage();
      res.writeHead(200);
      res.end(JSON.stringify({
        status: 'ok',
        model: model ? 'loaded' : 'not_loaded',
        uptime: `${uptime}s`,
        memory: { rss: `${(memUsage.rss / 1024 / 1024).toFixed(0)}MB`, heapUsed: `${(memUsage.heapUsed / 1024 / 1024).toFixed(0)}MB` },
        requests: modelHealth.totalRequests,
        errors: modelHealth.errorCount,
        sessions: sessionManager.size,
        busy: serverBusy,
      }));
      return;
    }
    res.writeHead(404);
    res.end(JSON.stringify({ error: 'Not found. Use WebSocket on /ws.' }));
  });

  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });
  wss.on('connection', (ws) => {
    console.error('[rwkv-server] WS client connected');
    handleConnection(ws);
  });

  httpServer.listen(PORT, process.env.RWKV_LISTEN_ADDR || '127.0.0.1', () => {
    writeFileSync(PID_FILE, JSON.stringify({ pid: process.pid, port: PORT, startedAt: Date.now(), protocol: 'ws' }));
    console.error(`[rwkv-server] Listening on 127.0.0.1:${PORT} (WS on /ws, HTTP /health)`);
  });
}

main().catch(err => {
  console.error('[rwkv-server] Failed to start:', err);
  process.exit(1);
});

process.on('SIGTERM', () => {
  console.error('[rwkv-server] SIGTERM received, shutting down...');
  sessionManager.destroyAll();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.error('[rwkv-server] SIGINT received, shutting down...');
  sessionManager.destroyAll();
  process.exit(0);
});
