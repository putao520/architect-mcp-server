#!/usr/bin/env node
// rwkv-server.mjs — 独立 RWKV 推理服务（单进程，多 MCP server 共享）
// 架构：独立 HTTP 服务 → 多个 MCP server 实例通过 HTTP 调用 → 模型只加载一次

import http from 'http';
import { join, dirname, resolve, relative } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, readFileSync, writeFileSync, statSync, readdirSync, mkdirSync } from 'fs';
import { createHash } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));

// === 模型加载（单例） ===

let model = null;
let tokenizer = null;

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

  model = new RwkvModel(modelPath, { threads, gpuLayers });
  tokenizer = new RwkvTokenizer(VOCAB_PATH);
}

// === 文件读取 ===

function readFilesAsContext(files, cwd, maxFileBytes = 200_000) {
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

const GEN_OPTS = { alphaPresence: 2.0, alphaFrequency: 0.1, alphaDecay: 0.99 };
const DEEP_THINK = { ...GEN_OPTS, maxRounds: 3, maxThinkTokens: 2048, maxAnswerTokens: 4096 };

async function executeDAG(args) {
  const { RwkvSession } = await import('./rwkv-binding.mjs');
  const { problem, files, context, nodes, deps, cwd } = args;

  const fileContext = files?.length ? readFilesAsContext(files, cwd) : '';

  // RWKV-7 G1 chat template 构建基础 session
  const baseSession = new RwkvSession(model, tokenizer);
  const userContent = [
    problem,
    fileContext ? `Context Files:\n${fileContext}` : '',
    context ? `Additional Context:\n${context}` : '',
  ].filter(Boolean).join('\n\n');

  baseSession.feedChatPrompt(userContent, {
    systemPrompt: 'You are an abstract reasoning engine. Analyze at the highest level of abstraction. Identify core patterns, hidden relationships, and architectural principles.',
  });
  const baseState = baseSession.exportState();

  // 拓扑排序 DAG 为层级
  const levels = topoSortLevels(nodes, deps);
  const results = {};
  const nodeMap = new Map(nodes.map(n => [n.id, n]));

  // 逐层执行（Think mode）
  for (const level of levels) {
    for (const node of level) {
      const nodeSession = new RwkvSession(model, tokenizer);
      nodeSession.importState(baseState);

      const parentIds = (deps || []).filter(d => d.to === node.id).map(d => d.from);
      const parentPart = parentIds.length > 0
        ? parentIds.map(pid => `Result from [${pid}]:\n${results[pid] || '(no result)'}`).join('\n\n') + '\n\n'
        : '';

      const nodeQuery = `${NODE_PROMPTS[node.type || 'abstract']}\n\nTask [${node.id}]: ${node.query}\n${parentPart}`;

      nodeSession.feedChatPrompt(nodeQuery, { think: true });
      const { answer } = nodeSession.thinkGenerate(2048, GEN_OPTS);
      results[node.id] = answer;
    }
  }

  // 综合推理（多轮 Think — 综合多个节点结果需要更深度推理）
  const synthSession = new RwkvSession(model, tokenizer);
  synthSession.importState(baseState);

  const allResults = Object.entries(results)
    .map(([id, text]) => `[${id}]: ${text}`)
    .join('\n\n---\n\n');

  const synthResult = synthSession.multiRoundThink(
    `All reasoning results:\n${allResults}\n\nNow synthesize all results into a unified, high-level conclusion. Identify cross-cutting themes, contradictions, and the overall architectural insight. Be abstract and conceptual.`,
    DEEP_THINK
  );
  const synthesis = synthResult.finalAnswer;

  // 格式化输出
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
}

// === Deep Read — 超大文件读取理解 ===
// RWKV 纯 RNN 优势：O(1) 每token推理，WKV state 固定 20.63MB
// 可以 feed 整个超大文件（无 Transformer 的上下文窗口限制），然后用 Think mode 回答问题

const DEEP_READ_MODES = {
  extract: 'Extract specific information from the context above to answer the question. Be precise, include relevant details and exact references.',
  summarize: 'Provide a comprehensive summary of the context above. Focus on key entities, relationships, decisions, and conclusions.',
  analyze: 'Analyze the context above in depth. Identify patterns, hidden relationships, architectural decisions, potential issues, and underlying principles.',
  qa: 'Answer the question based on the context above. If the answer cannot be found, explicitly state what is missing.',
};

// 先粗后精（两阶段）
// 阶段1：分段摘要 — 每个分块独立处理，避免信息衰减
// 阶段2：摘要定位 + 精读回答 — 只对相关分块做 Think mode 深度推理

async function deepRead(args) {
  const { RwkvSession } = await import('./rwkv-binding.mjs');
  const { files, question, mode = 'qa', cwd, maxTokens = 500000 } = args;

  const content = readFilesAsContext(files, cwd, 100_000_000);
  if (!content.trim()) {
    return { content: [{ type: 'text', text: 'DEEP READ: No content found in specified files.' }] };
  }

  // 按换行符边界分块（~50K tokens per chunk ≈ 200KB 文本）
  const CHUNK_CHARS = 200_000;
  const chunks = [];

  for (let i = 0; i < content.length; i += CHUNK_CHARS) {
    let end = Math.min(i + CHUNK_CHARS, content.length);
    if (end < content.length) {
      const lastNl = content.lastIndexOf('\n', end);
      if (lastNl > i) end = lastNl + 1;
    }
    chunks.push(content.slice(i, end));
  }

  // === 单分块：直接精读 ===
  if (chunks.length === 1) {
    const session = new RwkvSession(model, tokenizer);
    session.feedPrompt(chunks[0]);
    const modePrompt = DEEP_READ_MODES[mode] || DEEP_READ_MODES.qa;

    let answer;
    if (mode === 'analyze') {
      // 深度分析用多轮 Think
      const mr = session.multiRoundThink(`${modePrompt}\n\nQuestion: ${question.replace(/\n\n/g, '\n')}`, DEEP_THINK);
      answer = mr.finalAnswer;
    } else {
      session.feedPrompt(`\n\nUser: ${modePrompt}\n\nQuestion: ${question.replace(/\n\n/g, '\n')}\nAssistant:\n`);
      answer = session.thinkGenerate(4096, GEN_OPTS).answer;
    }

    return { content: [{ type: 'text', text: `DEEP READ COMPLETE\nMode: ${mode} | Single section\n\n## Answer\n${answer}` }] };
  }

  // === 多分块：先粗后精 ===

  // 阶段1：分段摘要（每个 chunk 独立 session，信息无衰减）
  const chunkSummaries = [];
  for (let ci = 0; ci < chunks.length; ci++) {
    const s = new RwkvSession(model, tokenizer);
    s.feedPrompt(chunks[ci]);
    s.feedPrompt('\n\nUser: Summarize the key content of this section in 2-3 sentences. Main topics, key terms, important data.\nAssistant:\n');
    const { answer } = s.thinkGenerate(512, GEN_OPTS);
    chunkSummaries.push(answer);
  }

  // 阶段2a：从摘要中定位相关 chunks
  const summariesText = chunkSummaries.map((sum, i) => `[Section ${i}]: ${sum}`).join('\n');
  const selectSession = new RwkvSession(model, tokenizer);
  selectSession.feedChatPrompt(
    `A document has ${chunks.length} sections with these summaries:\n\n${summariesText}\n\nQuestion: ${question}\n\nWhich sections are most relevant to answer this question? List only the section numbers separated by commas.`,
    {}
  );
  const selectionRaw = selectSession.generate(128, { ...GEN_OPTS, temperature: 0.3 });

  // 提取 section 编号
  const selectedIndices = [...new Set(
    [...selectionRaw.matchAll(/\d+/g)].map(m => parseInt(m[0], 10)).filter(i => i >= 0 && i < chunks.length)
  )].slice(0, 5);
  const targetIndices = selectedIndices.length > 0 ? selectedIndices : [0];

  // 阶段2b：精读相关 chunks（独立 session，信息完整）
  const relevantContent = targetIndices.map(i => chunks[i]).join('\n\n---\n\n');
  const answerSession = new RwkvSession(model, tokenizer);
  answerSession.feedPrompt(relevantContent);
  const modePrompt = DEEP_READ_MODES[mode] || DEEP_READ_MODES.qa;

  let answer;
  if (mode === 'analyze') {
    const mr = answerSession.multiRoundThink(`${modePrompt}\n\nQuestion: ${question.replace(/\n\n/g, '\n')}`, DEEP_THINK);
    answer = mr.finalAnswer;
  } else {
    answerSession.feedPrompt(`\n\nUser: ${modePrompt}\n\nQuestion: ${question.replace(/\n\n/g, '\n')}\nAssistant:\n`);
    answer = answerSession.thinkGenerate(4096, GEN_OPTS).answer;
  }

  return {
    content: [{
      type: 'text',
      text: `DEEP READ COMPLETE (coarse-to-fine)\nMode: ${mode} | Sections: ${chunks.length} | Relevant: [${targetIndices.join(', ')}]\n\n## Answer\n${answer}`,
    }],
  };
}

// === Tool 1: project_memory — 多级项目摘要 + State 持久化 ===

const STATES_DIR = join(process.env.HOME || '/tmp', '.rwkv-states');
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

async function projectSave(args) {
  const { RwkvSession } = await import('./rwkv-binding.mjs');
  const { project, path: rootPath, exclude = [], watch } = args;
  const effectiveProject = watch ? `watch-${project}` : project;
  const files = scanProject(rootPath, exclude);
  if (!files.length) return { content: [{ type: 'text', text: 'PROJECT SAVE: No files found.' }] };

  const checksums = {};
  for (const f of files) checksums[relative(rootPath, f)] = fileChecksum(f);

  // L3（文件级）：每个文件独立摘要
  const l3Summaries = {};
  for (const f of files) {
    const rel = relative(rootPath, f);
    const content = readOneFile(rel, f, 100_000_000);
    const s = new RwkvSession(model, tokenizer);
    s.feedPrompt(content);
    s.feedPrompt('\n\nUser: Summarize this file in 2-3 sentences: purpose, key exports, main logic.\nAssistant:\n');
    l3Summaries[rel] = (await s.thinkGenerate(512, GEN_OPTS)).answer;
  }

  // L2（模块级）：按目录分组摘要
  const dirs = {};
  for (const rel of Object.keys(l3Summaries)) {
    const dir = dirname(rel);
    if (!dirs[dir]) dirs[dir] = [];
    dirs[dir].push(l3Summaries[rel]);
  }
  const l2Summaries = {};
  for (const [dir, fileSums] of Object.entries(dirs)) {
    const s = new RwkvSession(model, tokenizer);
    s.feedPrompt(`Module [${dir}] contains these files:\n${fileSums.map((sum, i) => `- ${sum}`).join('\n')}`);
    s.feedPrompt('\n\nUser: Summarize this module: purpose, responsibilities, key interfaces.\nAssistant:\n');
    l2Summaries[dir] = (await s.thinkGenerate(512, GEN_OPTS)).answer;
  }

  // L1（项目级）：所有模块摘要 → 整体概述
  const allL2 = Object.entries(l2Summaries).map(([dir, sum]) => `[${dir}]: ${sum}`).join('\n');
  const l1Session = new RwkvSession(model, tokenizer);
  l1Session.feedPrompt(`Project modules:\n${allL2}`);
  l1Session.feedPrompt('\n\nUser: Describe the overall project architecture in 3-5 sentences: what it does, how it\'s organized, key design decisions.\nAssistant:\n');
  const l1 = (await l1Session.thinkGenerate(512, GEN_OPTS)).answer;

  // 全量 state：所有文件 feed → exportState
  const fullSession = new RwkvSession(model, tokenizer);
  const CHUNK = 262144;
  for (const f of files) {
    const content = readOneFile(relative(rootPath, f), f, 100_000_000);
    for (let i = 0; i < content.length; i += CHUNK) {
      let end = Math.min(i + CHUNK, content.length);
      if (end < content.length) { const nl = content.lastIndexOf('\n', end); if (nl > i) end = nl + 1; }
      fullSession.feedPrompt(content.slice(i, end));
    }
  }
  const state = fullSession.exportState();

  // 汇总 summary.md
  const summary = `# ${project}\n\n## Overview (L1)\n${l1}\n\n## Modules (L2)\n${Object.entries(l2Summaries).map(([d, s]) => `### ${d}\n${s}`).join('\n\n')}\n\n## Files (L3)\n${Object.entries(l3Summaries).map(([f, s]) => `### ${f}\n${s}`).join('\n\n')}\n`;

  const meta = { project: effectiveProject, path: rootPath, files: Object.keys(checksums), checksums, fileCount: files.length, watch: !!watch, createdAt: Date.now(), updatedAt: Date.now() };
  saveProjectState(effectiveProject, state, meta, summary);

  const label = watch ? `WATCH BASELINE: ${project}` : `PROJECT SAVED: ${project}`;
  return { content: [{ type: 'text', text: `${label}\nFiles: ${files.length} | Modules: ${Object.keys(l2Summaries).length}\n\n## Overview\n${l1}` }] };
}

async function projectQuery(args) {
  const { RwkvSession } = await import('./rwkv-binding.mjs');
  const loaded = loadProjectState(args.project);
  if (!loaded) return { content: [{ type: 'text', text: `PROJECT QUERY: "${args.project}" not found. Use project_save first.` }] };

  const session = new RwkvSession(model, tokenizer);
  session.importState(loaded.state);
  const mr = await session.multiRoundThink(args.question.replace(/\n\n/g, '\n'), DEEP_THINK);

  return { content: [{ type: 'text', text: `PROJECT QUERY: ${args.project}\nRounds: ${mr.totalRounds} | Converged: ${mr.converged}\n\n## Answer\n${mr.finalAnswer}` }] };
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

// === Tool 2: multi_lens — 多视角并行分析 ===

const LENS_PROMPTS = {
  security: 'Analyze from a SECURITY perspective: vulnerabilities, attack surfaces, auth issues, data exposure, OWASP risks.',
  performance: 'Analyze from a PERFORMANCE perspective: bottlenecks, latency, throughput, memory usage, scaling limits.',
  maintainability: 'Analyze from a MAINTAINABILITY perspective: code clarity, complexity, testability, documentation, tech debt.',
  architecture: 'Analyze from an ARCHITECTURE perspective: module boundaries, coupling, cohesion, patterns, extensibility.',
  reliability: 'Analyze from a RELIABILITY perspective: error handling, fault tolerance, recovery, monitoring, edge cases.',
};

async function multiLens(args) {
  const { RwkvSession } = await import('./rwkv-binding.mjs');
  const { files, question, lenses = ['security', 'performance', 'architecture'], extraLens, cwd } = args;

  const content = readFilesAsContext(files, cwd, 100_000_000);

  // 共享 baseState
  const baseSession = new RwkvSession(model, tokenizer);
  baseSession.feedPrompt(content);
  const baseState = baseSession.exportState();

  // 每个视角独立分析
  const perspectives = [];
  for (const lens of lenses) {
    const s = new RwkvSession(model, tokenizer);
    s.importState(baseState);
    s.feedPrompt(`\n\nUser: ${LENS_PROMPTS[lens] || lens}\n\nQuestion: ${question}\nAssistant:\n`);
    const { answer } = await s.thinkGenerate(2048, GEN_OPTS);
    perspectives.push({ lens, answer });
  }

  // 自定义视角
  if (extraLens) {
    const s = new RwkvSession(model, tokenizer);
    s.importState(baseState);
    s.feedPrompt(`\n\nUser: ${extraLens}\n\nQuestion: ${question}\nAssistant:\n`);
    perspectives.push({ lens: 'custom', answer: (await s.thinkGenerate(2048, GEN_OPTS)).answer });
  }

  // 汇总：交叉对比（多轮 Think — 多视角交叉是复杂推理）
  const synthSession = new RwkvSession(model, tokenizer);
  synthSession.importState(baseState);
  const allPerspectives = perspectives.map(p => `[${p.lens}]: ${p.answer}`).join('\n\n');
  const synthResult = await synthSession.multiRoundThink(
    `Cross-analyze these perspectives on "${question}":\n${allPerspectives}\n\nIdentify contradictions, trade-offs, and unified recommendations.`,
    DEEP_THINK
  );
  const synthesis = synthResult.finalAnswer;

  const out = [`MULTI-LENS ANALYSIS`, `Lenses: ${perspectives.map(p => p.lens).join(', ')}`, ''];
  for (const p of perspectives) { out.push(`## ${p.lens}`); out.push(p.answer); out.push(''); }
  out.push('## Synthesis'); out.push(synthesis);

  return { content: [{ type: 'text', text: out.join('\n') }] };
}

// === Tool 3: diff_read — 长文本对比 ===

async function diffRead(args) {
  const { RwkvSession } = await import('./rwkv-binding.mjs');
  const { filesA, filesB, question, labelA = 'A', labelB = 'B', cwd } = args;

  const contentA = readFilesAsContext(filesA, cwd, 100_000_000);
  const contentB = readFilesAsContext(filesB, cwd, 100_000_000);

  // 两路独立摘要
  const sA = new RwkvSession(model, tokenizer);
  sA.feedPrompt(contentA);
  sA.feedPrompt('\n\nUser: Describe the structure, key components, and main logic of this codebase.\nAssistant:\n');
  const summaryA = (await sA.thinkGenerate(2048, GEN_OPTS)).answer;

  const sB = new RwkvSession(model, tokenizer);
  sB.feedPrompt(contentB);
  sB.feedPrompt('\n\nUser: Describe the structure, key components, and main logic of this codebase.\nAssistant:\n');
  const summaryB = (await sB.thinkGenerate(2048, GEN_OPTS)).answer;

  // 对比分析（多轮 Think — 差异对比需要深度推理）
  const sC = new RwkvSession(model, tokenizer);
  const diffResult = await sC.multiRoundThink(
    `Compare these two versions:\n\n[${labelA}]:\n${summaryA}\n\n[${labelB}]:\n${summaryB}\n\nQuestion: ${question}`,
    DEEP_THINK
  );
  const diff = diffResult.finalAnswer;

  return { content: [{ type: 'text', text: `DIFF ANALYSIS: ${labelA} vs ${labelB}\n\n## ${labelA} Summary\n${summaryA}\n\n## ${labelB} Summary\n${summaryB}\n\n## Diff: ${question}\n${diff}` }] };
}

// === Tool 4: watch_analyze — 增量监控（≥10min 间隔，仅闲时） ===

const WATCH_MIN_INTERVAL = 10 * 60 * 1000; // 10 minutes
let serverBusy = false;

async function watchCheck(args) {
  const { project, question = 'Analyze the recent changes' } = args;
  const watchProject = `watch-${project}`;

  const loaded = loadProjectState(watchProject);
  if (!loaded) return { content: [{ type: 'text', text: `WATCH CHECK: "${project}" not set up. Use project_save with watch=true first.` }] };

  // 间隔检查（含状态信息 — 吸收原 watch_status）
  const elapsed = Date.now() - loaded.meta.updatedAt;
  const statusLine = `Files: ${loaded.meta.files.length} | Last check: ${(elapsed / 60000).toFixed(1)}min ago`;

  if (elapsed < WATCH_MIN_INTERVAL) {
    const remain = Math.ceil((WATCH_MIN_INTERVAL - elapsed) / 60000);
    return { content: [{ type: 'text', text: `WATCH STATUS: ${project}\n${statusLine} | Next available in: ${remain}min\n\nToo soon for analysis. Minimum 10min interval.` }] };
  }

  if (serverBusy) return { content: [{ type: 'text', text: `WATCH CHECK: Server busy, try later.\n${statusLine}` }] };

  const { RwkvSession } = await import('./rwkv-binding.mjs');

  serverBusy = true;
  try {
    // 计算当前 checksums
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

    // 检测新文件
    const currentFiles = scanProject(rootPath);
    for (const f of currentFiles) {
      const rel = relative(rootPath, f);
      if (!loaded.meta.checksums[rel]) newFiles.push(rel);
    }

    const allChanged = [...changedFiles, ...newFiles];
    if (!allChanged.length) return { content: [{ type: 'text', text: 'WATCH CHECK: No changes detected.' }] };

    // 增量分析：加载 baseline state → feed 变更内容 → Think mode
    const session = new RwkvSession(model, tokenizer);
    session.importState(loaded.state);

    const changeContent = allChanged.map(rel => {
      const abs = join(rootPath, rel);
      return readOneFile(rel, abs, 100_000_000);
    }).join('\n\n');

    session.feedPrompt(`\n\nUpdated files:\n${changeContent}`);
    session.feedPrompt(`\n\nUser: ${question}\n\nChanged files: ${allChanged.join(', ')}\nAssistant:\n`);
    const { answer } = await session.thinkGenerate(4096, GEN_OPTS);

    // 更新 state 和 meta
    const newState = session.exportState();
    loaded.meta.checksums = currentChecksums;
    loaded.meta.updatedAt = Date.now();
    saveProjectState(watchProject, newState, loaded.meta, `# Watch: ${project}\nLast check: ${new Date().toISOString()}\n`);

    return { content: [{ type: 'text', text: `WATCH CHECK: ${project}\nChanged: ${allChanged.length} files (${changedFiles.length} modified, ${newFiles.length} new)\n\n## Analysis\n${answer}` }] };
  } finally {
    serverBusy = false;
  }
}

// === HTTP 服务 ===

const PORT = parseInt(process.env.RWKV_SERVER_PORT || '19876', 10);
const PID_FILE = join(process.env.HOME || '/tmp', '.rwkv-server.json');

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200);
    res.end(JSON.stringify({ status: 'ok', model: model ? 'loaded' : 'not_loaded' }));
    return;
  }

  if (req.method === 'POST' && req.url === '/execute-dag') {
    try {
      const body = await readBody(req);
      const args = JSON.parse(body);
      const result = await executeDAG(args);
      res.writeHead(200);
      res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(500);
      res.end(JSON.stringify({
        content: [{ type: 'text', text: `RWKV SERVER ERROR: ${err.message}\n${err.stack?.split('\n').slice(0, 5).join('\n')}` }],
      }));
    }
    return;
  }

  if (req.method === 'POST' && req.url === '/deep-read') {
    try {
      const body = await readBody(req);
      const args = JSON.parse(body);
      const result = await deepRead(args);
      res.writeHead(200);
      res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(500);
      res.end(JSON.stringify({
        content: [{ type: 'text', text: `DEEP READ ERROR: ${err.message}\n${err.stack?.split('\n').slice(0, 5).join('\n')}` }],
      }));
    }
    return;
  }

  if (req.method === 'POST' && req.url === '/project-save') {
    try { const args = JSON.parse(await readBody(req)); res.writeHead(200); res.end(JSON.stringify(await projectSave(args))); }
    catch (err) { res.writeHead(500); res.end(JSON.stringify({ content: [{ type: 'text', text: `ERROR: ${err.message}` }] })); }
    return;
  }

  if (req.method === 'POST' && req.url === '/project-query') {
    try { const args = JSON.parse(await readBody(req)); res.writeHead(200); res.end(JSON.stringify(await projectQuery(args))); }
    catch (err) { res.writeHead(500); res.end(JSON.stringify({ content: [{ type: 'text', text: `ERROR: ${err.message}` }] })); }
    return;
  }

  if (req.method === 'POST' && req.url === '/project-list') {
    try { res.writeHead(200); res.end(JSON.stringify(projectList())); }
    catch (err) { res.writeHead(500); res.end(JSON.stringify({ content: [{ type: 'text', text: `ERROR: ${err.message}` }] })); }
    return;
  }

  if (req.method === 'POST' && req.url === '/multi-lens') {
    try { const args = JSON.parse(await readBody(req)); res.writeHead(200); res.end(JSON.stringify(await multiLens(args))); }
    catch (err) { res.writeHead(500); res.end(JSON.stringify({ content: [{ type: 'text', text: `ERROR: ${err.message}` }] })); }
    return;
  }

  if (req.method === 'POST' && req.url === '/diff-read') {
    try { const args = JSON.parse(await readBody(req)); res.writeHead(200); res.end(JSON.stringify(await diffRead(args))); }
    catch (err) { res.writeHead(500); res.end(JSON.stringify({ content: [{ type: 'text', text: `ERROR: ${err.message}` }] })); }
    return;
  }

  if (req.method === 'POST' && req.url === '/watch-check') {
    try { const args = JSON.parse(await readBody(req)); res.writeHead(200); res.end(JSON.stringify(await watchCheck(args))); }
    catch (err) { res.writeHead(500); res.end(JSON.stringify({ content: [{ type: 'text', text: `ERROR: ${err.message}` }] })); }
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: 'Not found' }));
});

// === 启动 ===

async function main() {
  console.error('[rwkv-server] Loading RWKV model...');
  await loadModel();
  console.error('[rwkv-server] Model loaded successfully.');

  server.listen(PORT, '127.0.0.1', () => {
    writeFileSync(PID_FILE, JSON.stringify({ pid: process.pid, port: PORT, startedAt: Date.now() }));
    console.error(`[rwkv-server] Listening on 127.0.0.1:${PORT}`);
  });
}

main().catch(err => {
  console.error('[rwkv-server] Failed to start:', err);
  process.exit(1);
});

// 优雅关闭
process.on('SIGTERM', () => {
  console.error('[rwkv-server] SIGTERM received, shutting down...');
  server.close(() => {
    try { require('fs').unlinkSync(PID_FILE); } catch {}
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.error('[rwkv-server] SIGINT received, shutting down...');
  server.close(() => {
    try { require('fs').unlinkSync(PID_FILE); } catch {}
    process.exit(0);
  });
});
