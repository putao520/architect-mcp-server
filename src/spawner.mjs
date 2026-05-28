import { query } from '@anthropic-ai/claude-agent-sdk';
import { buildStructuredContext, parseFileStructure } from './parser.mjs';
import { loadProvider, buildSdkEnv } from './env.mjs';
import { resolve, join, dirname } from 'path';
import { readFileSync, writeFileSync, unlinkSync, openSync, closeSync, existsSync, readdirSync, statSync } from 'fs';
import { fileURLToPath } from 'url';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { registerZ3Tools } from './z3-tools.mjs';
import { registerSpecTools } from './spec-tools.mjs';
import { registerCrudTools } from './spec/crud/index.mjs';
import { formatValidationResult } from './spec/utils/format.mjs';
import { registerLspTools } from './lsp/index.mjs';
import { registerDapTools } from './dap/index.mjs';
import { registerRevTools } from './rev/index.mjs';
import { parseSpecDir } from './spec/parse/html-parser.mjs';
import { validateAll } from './spec/validate/index.mjs';
import { validateLinks } from './spec/validate/links.mjs';
import { trackStatus } from './spec/status/tracker.mjs';
import { reportJson } from './spec/status/reporter.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// === RWKV WebSocket 客户端 ===
// 架构：rwkv-server.mjs 是独立 WS 服务，MCP server 通过 WS 客户端调用
// WS 连接持久化，session 跨请求复用，流式 token 接收

const RWKV_SERVER_PORT = parseInt(process.env.RWKV_SERVER_PORT || '19876', 10);
const RWKV_WS_URL = `ws://127.0.0.1:${RWKV_SERVER_PORT}/ws`;
const RWKV_PID_FILE = join(process.env.HOME || '/tmp', '.rwkv-server.json');
const RWKV_LOCK_FILE = '/tmp/rwkv-server-start.lock';

async function isServerAlive(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch { return false; }
}

function acquireLock() {
  try {
    const fd = openSync(RWKV_LOCK_FILE, 'wx');
    writeFileSync(fd, String(process.pid));
    closeSync(fd);
    return true;
  } catch { return false; }
}

function releaseLock() {
  try { unlinkSync(RWKV_LOCK_FILE); } catch {}
}

async function ensureRwkvServer() {
  try {
    const pidInfo = JSON.parse(readFileSync(RWKV_PID_FILE, 'utf-8'));
    if (pidInfo?.port && await isServerAlive(pidInfo.port)) return;
  } catch {}

  if (!acquireLock()) {
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 1000));
      if (await isServerAlive(RWKV_SERVER_PORT)) return;
      if (!existsSync(RWKV_LOCK_FILE) && acquireLock()) break;
    }
    if (await isServerAlive(RWKV_SERVER_PORT)) return;
    releaseLock();
    throw new Error('RWKV server failed to start within 60s (waited for another instance)');
  }

  try {
    const child = spawn('node', [join(__dirname, 'rwkv-server.mjs')], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env },
    });
    child.unref();

    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 1000));
      if (await isServerAlive(RWKV_SERVER_PORT)) return;
    }
    throw new Error('RWKV server failed to start within 60s');
  } finally {
    releaseLock();
  }
}

class RwkvWSClient {
  #ws = null;
  #pending = new Map(); // requestId → { resolve, reject }
  #onToken = null;
  #connectPromise = null;

  set onToken(cb) { this.#onToken = cb; }

  async connect() {
    if (this.#ws?.readyState === 1) return;
    if (this.#connectPromise) return this.#connectPromise;

    this.#connectPromise = this.#doConnect();
    try { await this.#connectPromise; }
    finally { this.#connectPromise = null; }
  }

  async #doConnect() {
    await ensureRwkvServer();
    this.#ws = new WebSocket(RWKV_WS_URL);

    await new Promise((resolve, reject) => {
      this.#ws.addEventListener('open', resolve, { once: true });
      this.#ws.addEventListener('error', (ev) => reject(new Error(ev.message || 'WS connect error')), { once: true });
      setTimeout(() => reject(new Error('WS connect timeout')), 10000);
    });

    this.#ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.requestId && this.#pending.has(msg.requestId)) {
        const { resolve } = this.#pending.get(msg.requestId);
        this.#pending.delete(msg.requestId);
        resolve(msg);
      }
      if (msg.type === 'token' && this.#onToken) this.#onToken(msg);
    });

    this.#ws.addEventListener('close', () => { this.#ws = null; });
    this.#ws.addEventListener('error', () => { this.#ws = null; });
  }

  async send(msg) {
    await this.connect();
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      this.#pending.set(requestId, { resolve, reject });
      this.#ws.send(JSON.stringify({ ...msg, requestId }));
      setTimeout(() => {
        if (this.#pending.has(requestId)) {
          this.#pending.delete(requestId);
          reject(new Error(`WS request timeout: ${msg.type}`));
        }
      }, 7200000);
    });
  }

  async createSession() {
    const resp = await this.send({ type: 'session.create' });
    if (resp.type === 'error') throw new Error(resp.message);
    return resp.sessionId;
  }

  async feedPrompt(sessionId, text) {
    const resp = await this.send({ type: 'session.feedPrompt', sessionId, text });
    if (resp.type === 'error') throw new Error(resp.message);
  }

  async feedChatPrompt(sessionId, text, options = {}) {
    const resp = await this.send({ type: 'session.feedChatPrompt', sessionId, text, options });
    if (resp.type === 'error') throw new Error(resp.message);
  }

  async generate(sessionId, maxTokens, options = {}) {
    const resp = await this.send({ type: 'session.generate', sessionId, maxTokens, options });
    if (resp.type === 'error') throw new Error(resp.message);
    return { text: resp.text, tokenCount: resp.tokenCount };
  }

  async thinkGenerate(sessionId, maxAnswerTokens, options = {}) {
    const resp = await this.send({ type: 'session.thinkGenerate', sessionId, maxAnswerTokens, options });
    if (resp.type === 'error') throw new Error(resp.message);
    return { thinking: resp.thinking, answer: resp.answer };
  }

  async multiRoundThink(sessionId, prompt, options = {}) {
    const resp = await this.send({ type: 'session.multiRoundThink', sessionId, prompt, options });
    if (resp.type === 'error') throw new Error(resp.message);
    return { rounds: resp.rounds, totalRounds: resp.totalRounds, converged: resp.converged, finalAnswer: resp.finalAnswer };
  }

  async exportState(sessionId) {
    const resp = await this.send({ type: 'session.exportState', sessionId });
    if (resp.type === 'error') throw new Error(resp.message);
    return resp.stateB64;
  }

  async importState(sessionId, stateB64) {
    const resp = await this.send({ type: 'session.importState', sessionId, stateB64 });
    if (resp.type === 'error') throw new Error(resp.message);
  }

  async pin(sessionId) {
    const resp = await this.send({ type: 'session.pin', sessionId });
    if (resp.type === 'error') throw new Error(resp.message);
  }

  async unpin(sessionId) {
    const resp = await this.send({ type: 'session.unpin', sessionId });
    if (resp.type === 'error') throw new Error(resp.message);
  }

  async destroySession(sessionId) {
    const resp = await this.send({ type: 'session.destroy', sessionId });
    if (resp.type === 'error') throw new Error(resp.message);
  }

  async callTool(tool, args) {
    const resp = await this.send({ type: 'tool.execute', tool, args });
    if (resp.type === 'error') throw new Error(resp.message);
    return resp;
  }

  disconnect() {
    if (this.#ws) { this.#ws.close(); this.#ws = null; }
  }
}

let rwkvClient = null;

async function getRwkvClient() {
  if (!rwkvClient) {
    rwkvClient = new RwkvWSClient();
    await rwkvClient.connect();
  }
  return rwkvClient;
}

// callRwkvTool — RWKV 工具已禁用，待恢复时取消注释
// async function callRwkvTool(tool, args) {
//   const client = await getRwkvClient();
//   const result = await client.callTool(tool, args);
//   return result;
// }

// === Architect Consultation 子 CC（Claude SDK） ===

const DEFAULT_MAX_TURNS = parseInt(process.env.ARCHITECT_MAX_TURNS || '3000', 10);

// === Worker Agent — 机械化低智力任务集群（DeepSeek v4 Flash） ===

const WORKER_TOOLS = [
  'Read', 'Glob', 'Grep', 'Bash', 'Edit',
  'mcp__arch__lsp_symbol_profile',
  'mcp__arch__lsp_trace_origin',
  'mcp__arch__lsp_code_action',
  'mcp__arch__lsp_find_dead_code',
  'mcp__arch__lsp_impact_analysis',
  'mcp__arch__spec_lint',
];

const WORKER_SYSTEM_FAST = `你是机械化任务执行器。
- 读文件用 Read，编辑用 Edit，搜索用 Grep/Glob，命令用 Bash
- 不加注释/文档，不解释，只输出变更摘要
- 不修改指令未提及的文件`;

const WORKER_SYSTEM_PRO = `你是高级任务执行器。
- 读文件用 Read，编辑用 Edit，搜索用 Grep/Glob，命令用 Bash
- 可用 LSP 工具做语义查询（lsp_symbol_profile/lsp_trace_origin/lsp_code_action）
- 理解任务意图，选最优路径，遵循项目既有规范
- 必要时用 WebSearch 查资料`;

const WORKER_MODELS = {
  fast: 'deepseek-v4-flash[1m]',
  fastXf: 'astron-code-latest',
  proGlm: 'GLM-5.1',
};

// 外部模型独立并发信号量：GLM ≤3, XF ≤5，互不影响
function createSemaphore(limit) {
  const sem = { running: 0, queue: [] };
  return {
    acquire() {
      return new Promise((resolve) => {
        if (sem.running < limit) { sem.running++; resolve(); }
        else sem.queue.push(resolve);
      });
    },
    release() {
      sem.running--;
      if (sem.queue.length > 0 && sem.running < limit) {
        sem.running++;
        sem.queue.shift()();
      }
    },
  };
}

const glmSem = createSemaphore(3);
const xfSem = createSemaphore(5);

// XF 稳定性保障：空响应、非200错误、重复内容
const XF_MAX_RETRIES = 2;

function simpleHash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(36);
}

async function runXfWithRetry(task, baseCwd, mode, upstreamResults, isDag, xfSeenHashes) {
  const maxAttempts = XF_MAX_RETRIES + 1;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const result = await runWorkerTask(
      { ...task, cwd: task.cwd || baseCwd }, baseCwd, buildSdkEnv('xf-astron'), mode, WORKER_MODELS.fastXf, upstreamResults, isDag
    );
    if (!result.success) {
      if (attempt < XF_MAX_RETRIES) { await new Promise(r => setTimeout(r, 500)); continue; }
      return result;
    }
    const raw = result.result || '';
    if (!raw || raw === '(no output)' || raw.trim().length < 10) {
      if (attempt < XF_MAX_RETRIES) { await new Promise(r => setTimeout(r, 500)); continue; }
      return { ...result, success: false, error: `XF empty response after ${maxAttempts} attempts` };
    }
    const hash = simpleHash(raw);
    if (xfSeenHashes.has(hash)) {
      if (attempt < XF_MAX_RETRIES) { await new Promise(r => setTimeout(r, 500)); continue; }
      return { ...result, success: false, error: `XF duplicate response after ${maxAttempts} attempts` };
    }
    xfSeenHashes.add(hash);
    return result;
  }
}

// === Helper functions ===

const RESULT_JSON_INSTRUCTION = `

完成任务后，必须在最后输出一个 JSON 结果块，用 \`\`\`result 包裹：

\`\`\`result
{
  "summary": "一句话总结执行结果",
  "output": { ... }
}
\`\`\`

summary 是给下游任务的简要说明。output 是结构化结果数据（如变更的文件列表、提取的类型信息、生成的代码等）。
如果你是 DAG 中有下游依赖的任务，下游会读取你的 summary 和 output。`;

function extractResultJson(raw) {
  const match = raw.match(/```result\s*\n([\s\S]*?)\n```/);
  if (!match) return { summary: raw.slice(0, 500), output: null };
  try {
    const parsed = JSON.parse(match[1]);
    return { summary: parsed.summary || '', output: parsed.output || null };
  } catch {
    return { summary: match[1].slice(0, 500), output: null };
  }
}

function buildPrompt(task, upstreamResults, isDag) {
  const parts = [];

  // 上游结果（DAG 模式下自动注入）
  if (upstreamResults?.length) {
    parts.push('## 上游任务结果\n');
    for (const ur of upstreamResults) {
      parts.push(`### [${ur.id}]`);
      parts.push(`- summary: ${ur.summary}`);
      if (ur.context) {
        if (ur.context.text) parts.push(`- 上下文: ${ur.context.text}`);
        if (ur.context.files?.length) parts.push(`- 相关文件: ${ur.context.files.join(', ')}`);
        if (ur.context.reqs?.length) parts.push(`- 关联需求: ${ur.context.reqs.join(', ')}`);
      }
      if (ur.output) parts.push(`- output:\n${JSON.stringify(ur.output, null, 2)}`);
      parts.push('');
    }
  }

  // 本任务自带上下文
  const ctx = task.context;
  if (ctx) {
    parts.push('## 任务上下文\n');
    if (ctx.text) parts.push(`${ctx.text}\n`);
    if (ctx.files?.length) {
      parts.push('相关文件:');
      for (const f of ctx.files) parts.push(`- ${f}`);
      parts.push('');
    }
    if (ctx.reqs?.length) {
      parts.push('关联需求:');
      for (const r of ctx.reqs) parts.push(`- ${r}`);
      parts.push('');
    }
  }

  // 任务描述或 steps
  if (task.steps?.length) {
    parts.push(task.steps.map((step, i) => `## Step ${i + 1}: ${step}`).join('\n\n'));
  } else {
    parts.push(task.description);
  }

  // DAG 模式下要求 JSON 输出
  if (isDag) parts.push(RESULT_JSON_INSTRUCTION);

  return parts.join('\n');
}

async function runWorkerTask(task, baseCwd, env, mode = 'fast', model = null, upstreamResults = null, isDag = false) {
  let finalResult = null;
  const isPro = mode === 'pro';
  const isGlm = model === WORKER_MODELS.proGlm;
  const isXf = model === WORKER_MODELS.fastXf;
  const prompt = buildPrompt(task, upstreamResults, isDag);

  if (isGlm) await glmSem.acquire();
  else if (isXf) await xfSem.acquire();
  try {
    for await (const message of query({
      prompt,
      options: {
        systemPrompt: { type: 'text', text: isPro ? WORKER_SYSTEM_PRO : WORKER_SYSTEM_FAST },
        cwd: task.cwd || baseCwd || process.cwd(),
        maxTurns: task.maxTurns,
        permissionMode: 'bypassPermissions',
        allowedTools: isPro ? ALL_TOOLS : WORKER_TOOLS,
        model: model || WORKER_MODELS.fast,
        effort: 'low',
        env,
      },
    })) {
      if (message.type === 'result') finalResult = message;
    }
  } catch (err) {
    if (isGlm) glmSem.release();
    else if (isXf) xfSem.release();
    return { id: task.id, success: false, error: err.message };
  }
  if (isGlm) glmSem.release();
  else if (isXf) xfSem.release();

  const success = finalResult?.subtype === 'success';
  const raw = finalResult?.result || '(no output)';
  const { summary, output } = isDag ? extractResultJson(raw) : { summary: '', output: null };
  return { id: task.id, success, result: raw, summary, output };
}

async function workerDispatch(args) {
  const { tasks, concurrency = 5, cwd, mode = 'fast' } = args;
  const env = buildSdkEnv('deepseek');
  const isPro = mode === 'pro';
  const maxConcurrency = Math.max(concurrency, 1);

  // === DAG 构建 ===
  const taskMap = new Map(tasks.map(t => [t.id, t]));
  const hasDeps = tasks.some(t => t.dependsOn?.length > 0);

  // 检查 dependsOn 引用合法性
  if (hasDeps) {
    for (const t of tasks) {
      for (const dep of (t.dependsOn || [])) {
        if (!taskMap.has(dep)) {
          return { content: [{ type: 'text', text: `WORKER DISPATCH ERROR: task "${t.id}" dependsOn "${dep}" not found` }] };
        }
      }
    }
    // 环检测：拓扑排序
    const inDegree = new Map(tasks.map(t => [t.id, 0]));
    for (const t of tasks) {
      for (const dep of (t.dependsOn || [])) {
        inDegree.set(t.id, (inDegree.get(t.id) || 0) + 1);
      }
    }
    const queue = tasks.filter(t => (inDegree.get(t.id) || 0) === 0).map(t => t.id);
    let sorted = 0;
    const topoQueue = [...queue];
    while (topoQueue.length > 0) {
      const id = topoQueue.shift();
      sorted++;
      for (const t of tasks) {
        if ((t.dependsOn || []).includes(id)) {
          const deg = (inDegree.get(t.id) || 1) - 1;
          inDegree.set(t.id, deg);
          if (deg === 0) topoQueue.push(t.id);
        }
      }
    }
    if (sorted < tasks.length) {
      const cycleTasks = tasks.filter(t => (inDegree.get(t.id) || 0) > 0).map(t => t.id);
      return { content: [{ type: 'text', text: `WORKER DISPATCH ERROR: cycle detected among tasks: ${cycleTasks.join(', ')}` }] };
    }
  }

  // === 执行 ===
  const resultMap = new Map(); // id → { success, result/error }
  const runOrder = []; // 记录执行顺序

  if (!hasDeps) {
    let extIdx = 0;
    const PRO_GLM_LIMIT = 3;
    const FAST_XF_LIMIT = 5;
    const xfSeenHashes = new Set();
    for (let i = 0; i < tasks.length; i += maxConcurrency) {
      const batch = tasks.slice(i, i + maxConcurrency);
      const batchResults = await Promise.all(
        batch.map((task) => {
          const idx = extIdx++;
          if (isPro) {
            if (idx < PRO_GLM_LIMIT) {
              return runWorkerTask({ ...task, cwd: task.cwd || cwd }, cwd, buildSdkEnv('glm'), mode, WORKER_MODELS.proGlm);
            }
            return runXfWithRetry(task, cwd, mode, null, false, xfSeenHashes);
          }
          if (idx < FAST_XF_LIMIT) {
            return runXfWithRetry(task, cwd, mode, null, false, xfSeenHashes);
          }
          return runWorkerTask({ ...task, cwd: task.cwd || cwd }, cwd, env, mode, null);
        })
      );
      for (let j = 0; j < batchResults.length; j++) {
        resultMap.set(batch[j].id, batchResults[j]);
        runOrder.push(batchResults[j]);
      }
    }
  } else {
    // DAG 调度：拓扑层序执行，同层内按 concurrency 并行
    const inDegree = new Map(tasks.map(t => [t.id, 0]));
    const dependents = new Map(); // id → [被谁依赖]
    for (const t of tasks) {
      dependents.set(t.id, []);
      for (const dep of (t.dependsOn || [])) {
        inDegree.set(t.id, (inDegree.get(t.id) || 0) + 1);
        dependents.get(dep).push(t.id);
      }
    }

    let ready = tasks.filter(t => (inDegree.get(t.id) || 0) === 0).map(t => t.id);
    let extIdx = 0;
    const PRO_GLM_LIMIT = 3;
    const FAST_XF_LIMIT = 5;
    const xfSeenHashes = new Set();

    while (ready.length > 0) {
      const batch = ready.splice(0, maxConcurrency);
      const batchResults = await Promise.all(
        batch.map((id) => {
          const task = taskMap.get(id);
          const idx = extIdx++;
          const upstreamResults = (task.dependsOn || [])
            .filter(depId => resultMap.has(depId) && resultMap.get(depId).success)
            .map(depId => {
              const dep = resultMap.get(depId);
              return {
                id: depId,
                summary: dep.summary || '',
                output: dep.output || null,
                context: taskMap.get(depId)?.context || null,
              };
            });
          if (isPro) {
            if (idx < PRO_GLM_LIMIT) {
              return runWorkerTask({ ...task, cwd: task.cwd || cwd }, cwd, buildSdkEnv('glm'), mode, WORKER_MODELS.proGlm, upstreamResults, true);
            }
            return runXfWithRetry(task, cwd, mode, upstreamResults, true, xfSeenHashes);
          }
          if (idx < FAST_XF_LIMIT) {
            return runXfWithRetry(task, cwd, mode, upstreamResults, true, xfSeenHashes);
          }
          return runWorkerTask({ ...task, cwd: task.cwd || cwd }, cwd, env, mode, null, upstreamResults, true);
        })
      );

      for (let j = 0; j < batchResults.length; j++) {
        const id = batch[j];
        const r = batchResults[j];
        resultMap.set(id, r);
        runOrder.push(r);

        // 依赖任务失败 → 下游跳过
        if (!r.success) {
          const skip = (taskId) => {
            if (resultMap.has(taskId)) return;
            resultMap.set(taskId, { id: taskId, success: false, error: `skipped: upstream "${id}" failed` });
            runOrder.push(resultMap.get(taskId));
            for (const dep of (dependents.get(taskId) || [])) skip(dep);
          };
          for (const dep of (dependents.get(id) || [])) skip(dep);
          continue;
        }

        // 释放下游
        for (const dep of (dependents.get(id) || [])) {
          if (resultMap.has(dep)) continue;
          const deg = (inDegree.get(dep) || 1) - 1;
          inDegree.set(dep, deg);
          if (deg === 0) ready.push(dep);
        }
      }
    }
  }

  // === 汇总输出 ===
  const extLimit = isPro ? Math.min(3, tasks.length) : Math.min(5, tasks.length);
  const extLabel = isPro ? `GLM-5.1` : `XF-Astron`;
  const restLabel = isPro ? 'XF-Astron' : 'DeepSeek v4 Flash';
  const engineLabel = `${extLabel}(${extLimit}) + ${restLabel}(${tasks.length - extLimit})`;
  const dagLabel = hasDeps ? ' | DAG: yes' : ' | DAG: no';
  const out = [`WORKER DISPATCH COMPLETE`, `Tasks: ${tasks.length} | Concurrency: ${maxConcurrency} | Engine: ${engineLabel}${dagLabel} | Mode: ${mode}`, ''];
  const succeeded = runOrder.filter(r => r.success).length;

  for (const r of runOrder) {
    out.push(`## [${r.id}] ${r.success ? 'DONE' : 'FAILED'}`);
    out.push(r.success ? (r.result || '(no output)') : `ERROR: ${r.error || r.result}`);
    out.push('');
  }

  out.push(`Summary: ${succeeded}/${runOrder.length} succeeded`);

  return { content: [{ type: 'text', text: out.join('\n') }] };
}

const LSP_TOOLS = [
  'mcp__arch__lsp_symbol_profile',
  'mcp__arch__lsp_trace_origin',
  'mcp__arch__lsp_find_dead_code',
  'mcp__arch__lsp_data_query',
  'mcp__arch__lsp_code_action',
  'mcp__arch__lsp_safe_delete',
];

const DAP_TOOLS = [
  'mcp__arch__dap_check_env',
  'mcp__arch__dap_start_session',
  'mcp__arch__dap_set_breakpoint',
  'mcp__arch__dap_run_control',
  'mcp__arch__dap_stack_trace',
  'mcp__arch__dap_evaluate',
  'mcp__arch__dap_analyze_binary',
];

const SPEC_TOOLS = [
  'mcp__arch__spec_lint', 'mcp__arch__spec_status', 'mcp__arch__spec_migrate', 'mcp__arch__spec_audit',
  'mcp__arch__spec_openapi', 'mcp__arch__spec_schema', 'mcp__arch__spec_crud',
];

const REV_TOOLS = [
  'mcp__arch__rev_check_env', 'mcp__arch__rev_import_binary', 'mcp__arch__rev_decompile',
  'mcp__arch__rev_list_functions', 'mcp__arch__rev_cross_references', 'mcp__arch__rev_search_strings',
  'mcp__arch__rev_analyze_control_flow', 'mcp__arch__rev_symexec',
];

const ALL_TOOLS = [
  'Read', 'Glob', 'Grep', 'Bash', 'WebSearch', 'WebFetch',
  ...LSP_TOOLS, ...DAP_TOOLS, ...SPEC_TOOLS, ...REV_TOOLS,
];

const LSP_DAP_GUIDE = `
工具使用铁律：
- 分析代码必须用 LSP 工具：lsp_symbol_profile 查符号全貌、lsp_trace_origin 追数据流、lsp_impact_analysis 查影响范围、lsp_call_graph 查调用链、lsp_data_query 查配置。不要只用 Read/Grep。
- 需要验证运行时行为时用 DAP 工具：dap_start_session 启动调试、dap_set_breakpoint 下断点、dap_evaluate 查看变量值、dap_inspect LSP+DAP融合诊断。
- 上网搜索技术背景用 WebSearch 和 WebFetch。
- 分析 SPEC 时先提取 REQ 清单和章节结构，不要逐行读文本。
- 分析代码时先用 lsp_document_symbols 获取符号表，再按需深入。`;

const SYSTEM_PROMPTS = {
  consult: `你是一位资深软件架构师，专精大规模系统设计和架构决策。
${LSP_DAP_GUIDE}
输出格式：
1. 问题分析
2. 现状评估（结合代码库发现）
3. 方案建议（含利弊分析）
4. 实施路径`,

  audit: `你是一位严格的 SPEC 审计专家，从业务场景出发验证设计的正确性和可行性。
${LSP_DAP_GUIDE}
审计维度：
- 完整性：需求是否完整覆盖
- 可行性：技术方案是否可行
- 一致性：SPEC 与代码实现是否一致
- 可测试性：验收标准是否可测试
- 安全性：是否有安全漏洞
- 性能：是否有性能瓶颈
- 风险点：潜在问题和遗漏

输出格式：按严重程度分级（Critical/Major/Minor/Info）的审计报告。`,

  review: `你是一位代码架构审查专家，专精设计模式和架构质量评估。
${LSP_DAP_GUIDE}
审查维度：
- 设计模式使用是否合理
- 模块划分和职责边界
- 依赖关系是否清晰
- 代码复杂度和可维护性
- 扩展性和演进能力
- SOLID 原则遵守情况

输出格式：问题列表（按严重程度排序）+ 改进建议。`,

  analyze: `你是一位子系统分析专家，专精数据流、调用链和状态管理的全链路追踪。
${LSP_DAP_GUIDE}
分析维度：
- 数据流：数据从哪里来、经过哪些转换、到哪里去
- 调用链：函数/模块间的调用关系
- 状态管理：状态在哪里创建、修改、销毁
- 边界条件：错误处理、异常路径、并发问题
- 性能热点：I/O 密集、CPU 密集、内存密集点

输出格式：调用图 + 数据流图 + 关键发现。`,
};

async function retryWithBackoff(fn, maxRetries = 100) {
  for (let i = 0; i <= maxRetries; i++) {
    try { return await fn(); } catch (err) {
      if (i < maxRetries && /503|500|no available|Internal Server Error|socket connection/i.test(err.message || '')) {
        const delay = Math.min(Math.pow(2, i) * 1000, 60000);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
}

export async function spawnConsultation({ taskType, userPrompt, cwd, maxTurns, env }) {
  const effectiveCwd = cwd || process.cwd();
  const turns = maxTurns || DEFAULT_MAX_TURNS;

  const messages = [];
  let finalResult = null;

  try {
    await retryWithBackoff(async () => {
      for await (const message of query({
        prompt: userPrompt,
        options: {
          systemPrompt: { type: 'preset', preset: 'claude_code', append: SYSTEM_PROMPTS[taskType] },
          cwd: effectiveCwd,
          maxTurns: turns,
          permissionMode: 'bypassPermissions',
          allowedTools: ALL_TOOLS,
          model: 'claude-opus-4-7',
          effort: 'max',
          env,
        },
      })) {
        if (message.type === 'assistant' && message.message?.content) {
          for (const block of message.message.content) {
            if ('text' in block && block.text) messages.push(block.text);
          }
        } else if (message.type === 'result') {
          finalResult = message;
        }
      }
    });
  } catch (err) {
    const full = messages.join('\n');
    const head = full.slice(0, 4000);
    const tail = full.slice(-4000);
    return {
      content: [{
        type: 'text',
        text: `ARCHITECT ERROR: ${err.message}\n\nOutput (head):\n${head}\n\n...\n\nOutput (tail):\n${tail}`,
      }],
    };
  }

  if (finalResult && finalResult.subtype === 'success' && finalResult.result) {
    return { content: [{ type: 'text', text: finalResult.result }] };
  }

  const output = [];
  if (finalResult) {
    output.push(`Task ended: ${finalResult.subtype}`);
    if (finalResult.errors?.length) output.push(`Errors: ${finalResult.errors.join('; ')}`);
    output.push('');
  }
  output.push('=== Analysis Output ===');
  output.push(messages.join('\n'));
  return { content: [{ type: 'text', text: output.join('\n') }] };
}

// === 工具注册 ===

export function registerTools(server, env) {
  // === Tool 1: architect — 架构师子 CC（4 种 task_type） ===

  const ARCHITECT_DEFAULTS = {
    consult: { turns: 3000, description: '架构咨询' },
    audit: { turns: 5000, description: 'SPEC 审计' },
    review: { turns: 4000, description: '代码审查' },
    analyze: { turns: 4000, description: '深度分析' },
  };

  server.tool(
    'architect',
    `架构师(Opus 4.7子进程)。consult=架构咨询 | audit=SPEC审计 | review=代码审查 | analyze=深度分析。`,
    {
      task_type: z.enum(['consult', 'audit', 'review', 'analyze']).describe('consult=架构咨询 | audit=SPEC审计 | review=代码审查 | analyze=深度分析'),
      prompt: z.string().describe('consult/analyze: 问题描述 | audit: SPEC路径 | review: 审查目标路径'),
      cwd: z.string().optional().describe('项目工作目录'),
      context: z.array(z.string()).default([]).describe('相关文件/入口文件路径'),
      maxTurns: z.number().optional().describe('子 CC 最大轮次'),
      focus: z.enum(['architecture', 'patterns', 'dependencies', 'complexity', 'all']).optional().describe('[review] 审查重点'),
      analysis_type: z.enum(['dataflow', 'callchain', 'state', 'all']).optional().describe('[analyze] 分析类型'),
      dimensions: z.array(z.string()).default([]).describe('[audit] 审计维度，不传则全7维度'),
    },
    async (args) => {
      const { task_type, prompt, cwd, context, maxTurns, focus, analysis_type, dimensions } = args;
      const defaults = ARCHITECT_DEFAULTS[task_type];
      let userPrompt;

      switch (task_type) {
        case 'consult': {
          const ctx = await buildStructuredContext(context);
          userPrompt = prompt + ctx;
          break;
        }
        case 'audit': {
          const resolved = resolve(prompt);
          const parsed = await parseFileStructure(resolved);
          userPrompt = `审计 SPEC: ${prompt}`;
          if (parsed) userPrompt += `\n\nSPEC 结构:\n${JSON.stringify(parsed, null, 2)}`;
          if (dimensions?.length) userPrompt += `\n\n重点审计维度: ${dimensions.join('、')}`;
          // 自动前置：spec validate + links + status
          try {
            const index = parseSpecDir(resolved);
            const vResult = validateAll(index);
            const lResult = validateLinks(index);
            const sResult = trackStatus(index);
            const preAudit = [];
            preAudit.push(formatValidationResult('SPEC VALIDATE', vResult, '\n\n--- 自动验证: '));
            preAudit.push(formatValidationResult('SPEC LINKS', lResult, '\n\n--- 自动验证: '));
            preAudit.push(`\n\n--- 自动验证: REQ STATUS ---\n${reportJson(sResult)}`);
            userPrompt += preAudit.join('');
          } catch {}
          // 自动前置：源码结构概览
          try {
            const SRC_DIRS = ['src', 'lib', 'pkg', 'app', 'cmd', 'internal', 'server', 'core', 'modules', 'packages', 'apps', 'services'];
            const srcDir = SRC_DIRS.find(d => existsSync(join(resolved, d)));
            if (srcDir) {
              const srcPath = join(resolved, srcDir);
              const entries = readdirSync(srcPath, { withFileTypes: true })
                .filter(e => !e.name.startsWith('.') && !e.name.startsWith('__'))
                .map(e => e.isDirectory() ? `${e.name}/` : e.name);
              userPrompt += `\n\n--- 自动验证: SOURCE STRUCTURE ---\n${srcDir}/ → ${entries.join(', ')}`;
              const LANG_MARKERS = [
                ['tsconfig.json', 'TypeScript'], ['package.json', 'Node.js'], ['deno.json', 'Deno'],
                ['bun.lockb', 'Bun'], ['Cargo.toml', 'Rust'], ['go.mod', 'Go'],
                ['pyproject.toml', 'Python'], ['setup.py', 'Python'], ['Pipfile', 'Python'],
                ['pom.xml', 'Java/Kotlin'], ['build.gradle', 'Java/Kotlin'], ['build.gradle.kts', 'Kotlin'],
                ['CMakeLists.txt', 'C/C++'], ['Makefile', 'C/C++'], ['meson.build', 'C/C++'],
                ['Gemfile', 'Ruby'], ['composer.json', 'PHP'], ['mix.exs', 'Elixir'],
                ['Package.swift', 'Swift'], ['build.zig', 'Zig'], ['cabal.project', 'Haskell'],
                ['pubspec.yaml', 'Dart/Flutter'], ['*.sln', '.NET'],
              ];
              const detected = LANG_MARKERS.filter(([f]) => existsSync(join(resolved, f))).map(([, lang]) => lang);
              if (detected.length) userPrompt += `\nDetected: ${[...new Set(detected)].join(', ')}`;
              userPrompt += '\nUse lsp_symbol_profile, lsp_dependency_graph, lsp_find_dead_code for deeper analysis';
            }
          } catch {}
          break;
        }
        case 'review': {
          const focusMap = { architecture: '架构设计', patterns: '设计模式', dependencies: '依赖关系', complexity: '代码复杂度', all: '全面审查' };
          userPrompt = `审查目标: ${prompt}\n审查重点: ${focusMap[focus || 'all']}`;
          break;
        }
        case 'analyze': {
          const typeMap = { dataflow: '数据流', callchain: '调用链', state: '状态管理', all: '全链路' };
          userPrompt = `分析子系统: ${prompt}\n分析类型: ${typeMap[analysis_type || 'all']}`;
          if (context?.length) {
            const ctx = await buildStructuredContext(context);
            userPrompt += `\n\n入口文件:\n${context.map(f => `- ${f}`).join('\n')}${ctx}`;
          }
          break;
        }
      }

      try {
        return await spawnConsultation({
          taskType: task_type,
          userPrompt,
          cwd,
          maxTurns: maxTurns || defaults.turns,
          env,
        });
      } catch (err) {
        return { content: [{ type: 'text', text: `ARCHITECT ERROR: ${err.message}\n${err.stack?.split('\n').slice(0, 5).join('\n')}` }] };
      }
    },
  );

  // === RWKV 工具已禁用（2.9B 模型能力不足，待更换更强模型后恢复） ===
  // abstract_reasoning 和 deep_read 注册已注释
  //
  // 原始注册代码见 git history

  // === Tool 4: worker_dispatch — 高并发批量任务执行器 ===

  server.tool(
    'worker_dispatch',
    `批量机械化任务执行器。仅用于 3+ 个同模式任务的并行批处理。这不是子 Agent，worker 没有架构判断能力。

【适用场景】必须同时满足：任务数≥3 + 每个任务指令明确无歧义 + 不需要架构决策
- fast：批量重命名、import整理、格式化、死代码清理、find-replace、console.log清除、测试桩生成
- pro：需 LSP 查引用后决策的重构、涉及类型推断的类型注解、需理解语义的跨文件修改

【禁止场景】
- 任务数<3 → 直接在主会话执行，不要 dispatch
- 需要架构设计/方案选择 → 主会话或 architect
- 复杂 bug 诊断 → debugger
- 需要来回确认/澄清的任务 → 主会话
- 把它当"能干活的子 Agent"随意扔单个任务 → 成本浪费

【DAG】dependsOn 声明依赖，上游失败下游跳过。上游输出自动注入下游 prompt。`,
    {
      tasks: z.array(z.object({
        id: z.string().describe('任务标识（如 "rename-auth", "add-types"）'),
        description: z.string().describe('给 worker 的完整指令，必须足够具体到可以直接执行。与 steps 二选一'),
        steps: z.array(z.string()).optional().describe('任务链：共享上下文的子任务列表，一个 worker 串行执行。与 description 二选一'),
        dependsOn: z.array(z.string()).optional().describe('依赖的 task id。这些 task 完成后本 task 才执行。无此字段=立即执行。'),
        context: z.object({
          text: z.string().optional().describe('背景信息、约束条件'),
          files: z.array(z.string()).optional().describe('相关文件路径'),
          reqs: z.array(z.string()).optional().describe('SPEC REQ 编号（如 ["REQ-3.1.2"]）'),
        }).optional().describe('任务上下文'),
        cwd: z.string().optional().describe('工作目录'),
        maxTurns: z.number().optional().describe('最大轮次（fast 默认20，pro 默认50）'),
      })).describe('任务列表，≥3 个才值得 dispatch'),
      concurrency: z.number().default(5).describe('同层最大并行数（默认 5）'),
      cwd: z.string().optional().describe('默认工作目录'),
      mode: z.enum(['fast', 'pro']).default('fast').describe('fast=机械化字面量操作 | pro=需查引用/理解语义（成本高，慎用）'),
    },
    async (args) => {
      try { return await workerDispatch(args); }
      catch (err) { return { content: [{ type: 'text', text: `WORKER DISPATCH ERROR: ${err.message}\n${err.stack?.split('\n').slice(0, 3).join('\n')}` }] }; }
    },
  );

  // === Z3 SPEC Verification Tools ===
  registerZ3Tools(server);

  // === Spec-Tools（validate/links/status/graph/migrate） ===
  registerSpecTools(server);

  // === Spec CRUD（确定性 HTML 结构化元素读写） ===
  registerCrudTools(server);

  // === LSP Tools（symbol_profile/code_action/refactoring/graphs） ===
  registerLspTools(server);

  // === DAP Tools（debug sessions/breakpoints/evaluate） ===
  registerDapTools(server);

  // === Reverse Engineering Tools（decompile/disassemble/symexec） ===
  registerRevTools(server);
}
