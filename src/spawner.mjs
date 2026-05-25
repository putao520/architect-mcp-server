import { query } from '@anthropic-ai/claude-agent-sdk';
import { buildStructuredContext, parseFileStructure } from './parser.mjs';
import { loadProvider } from './env.mjs';
import { resolve, join, dirname } from 'path';
import { readFileSync, writeFileSync, unlinkSync, openSync, closeSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { z } from 'zod';
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { registerZ3Tools } from './z3-tools.mjs';

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

function loadWorkerEnv() {
  const provider = loadProvider('deepseek');
  if (!provider) throw new Error('DeepSeek provider not found. Create ~/.gsc/providers/deepseek.json');
  const env = { ...process.env };
  env.ANTHROPIC_BASE_URL = provider.endpoint;
  const enabled = (provider.accounts || []).filter(a => a.enabled !== false);
  if (enabled.length > 0) env.ANTHROPIC_AUTH_TOKEN = enabled[0].token;
  if (provider.env) {
    for (const e of provider.env) env[e.name] = e.value;
  }
  return env;
}

const WORKER_TOOLS = [
  'Read', 'Glob', 'Grep', 'Bash', 'Edit',
  'mcp__lsp-tools__lsp_hover', 'mcp__lsp-tools__lsp_references',
  'mcp__lsp-tools__lsp_rename', 'mcp__lsp-tools__lsp_edit_references',
  'mcp__lsp-tools__lsp_document_symbols', 'mcp__lsp-tools__lsp_implementations',
];

const WORKER_SYSTEM_FAST = `
你是机械化任务执行器。严格按指令执行，不做设计决策。
- 不在要求时添加注释或文档
- 只输出执行结果和变更摘要
- 遇到歧义按最简方案处理
- 不修改指令未提及的文件`;

const WORKER_SYSTEM_PRO = `
你是高级任务执行器，具备代码理解和独立判断能力。
- 理解任务意图，选择最优实现路径
- 遇到歧义时基于上下文做合理推断，必要时主动搜索代码库获取信息
- 确保实现符合项目既有架构模式和编码规范
- 输出变更摘要和关键决策说明`;

const WORKER_MODELS = {
  fast: 'deepseek-v4-flash[1m]',
  pro: 'deepseek-v4-pro[1m]',
};

async function runWorkerTask(task, baseCwd, env, mode = 'fast') {
  const messages = [];
  let finalResult = null;
  const isPro = mode === 'pro';

  try {
    for await (const message of query({
      prompt: task.description,
      options: {
        systemPrompt: { type: 'preset', preset: 'claude_code', append: isPro ? WORKER_SYSTEM_PRO : WORKER_SYSTEM_FAST },
        cwd: task.cwd || baseCwd || process.cwd(),
        maxTurns: task.maxTurns || (isPro ? 200 : 100),
        permissionMode: 'bypassPermissions',
        allowedTools: isPro ? ALL_TOOLS : WORKER_TOOLS,
        model: WORKER_MODELS[mode],
        effort: isPro ? 'medium' : 'low',
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
  } catch (err) {
    return { id: task.id, success: false, error: err.message };
  }

  const success = finalResult?.subtype === 'success';
  const result = finalResult?.result || messages.join('\n');
  return { id: task.id, success, result: result.slice(0, 4000) };
}

async function workerDispatch(args) {
  const { tasks, concurrency = 5, cwd, mode = 'fast' } = args;
  const env = loadWorkerEnv();

  const results = [];
  const maxConcurrency = Math.max(concurrency, 1);

  for (let i = 0; i < tasks.length; i += maxConcurrency) {
    const batch = tasks.slice(i, i + maxConcurrency);
    const batchResults = await Promise.all(
      batch.map(task => runWorkerTask({ ...task, cwd: task.cwd || cwd }, cwd, env, mode))
    );
    results.push(...batchResults);
  }

  const engineLabel = mode === 'pro' ? 'DeepSeek v4 Pro' : 'DeepSeek v4 Flash';
  const out = [`WORKER DISPATCH COMPLETE`, `Tasks: ${tasks.length} | Concurrency: ${maxConcurrency} | Engine: ${engineLabel} | Mode: ${mode}`, ''];
  const succeeded = results.filter(r => r.success).length;

  for (const r of results) {
    out.push(`## [${r.id}] ${r.success ? 'DONE' : 'FAILED'}`);
    out.push(r.success ? (r.result || '(no output)') : `ERROR: ${r.error || r.result}`);
    out.push('');
  }

  out.push(`Summary: ${succeeded}/${results.length} succeeded`);

  return { content: [{ type: 'text', text: out.join('\n') }] };
}

const LSP_TOOLS = [
  'mcp__lsp-tools__lsp_hover', 'mcp__lsp-tools__lsp_references',
  'mcp__lsp-tools__lsp_implementations', 'mcp__lsp-tools__lsp_type_definition',
  'mcp__lsp-tools__lsp_document_symbols', 'mcp__lsp-tools__lsp_document_highlight',
  'mcp__lsp-tools__lsp_folding_range', 'mcp__lsp-tools__lsp_diagnostic',
  'mcp__lsp-tools__lsp_workspace_symbol', 'mcp__lsp-tools__lsp_trace_origin',
  'mcp__lsp-tools__lsp_data_query', 'mcp__lsp-tools__lsp_rename',
  'mcp__lsp-tools__lsp_edit_references', 'mcp__lsp-tools__lsp_apply_code_action',
  'mcp__lsp-tools__lsp_organize_imports', 'mcp__lsp-tools__lsp_format',
  'mcp__lsp-tools__lsp_add_import', 'mcp__lsp-tools__lsp_delete_symbol',
];

const DAP_TOOLS = [
  'mcp__dap-tools__dap_check_env', 'mcp__dap-tools__dap_launch',
  'mcp__dap-tools__dap_attach', 'mcp__dap-tools__dap_set_breakpoint',
  'mcp__dap-tools__dap_set_function_breakpoint', 'mcp__dap-tools__dap_continue',
  'mcp__dap-tools__dap_step', 'mcp__dap-tools__dap_stack_trace',
  'mcp__dap-tools__dap_variables', 'mcp__dap-tools__dap_evaluate',
  'mcp__dap-tools__dap_disconnect', 'mcp__dap-tools__dap_elf_symbols',
  'mcp__dap-tools__dap_dwarf_info', 'mcp__dap-tools__dap_disassemble',
];

const ALL_TOOLS = [
  'Read', 'Glob', 'Grep', 'Bash', 'WebSearch', 'WebFetch',
  ...LSP_TOOLS, ...DAP_TOOLS,
];

const LSP_DAP_GUIDE = `
工具使用铁律：
- 分析代码必须用 LSP 工具：lsp_hover 查类型、lsp_references 查引用、lsp_trace_origin 追数据流、lsp_implementations 查实现、lsp_document_symbols 看文件结构。不要只用 Read/Grep。
- 需要验证运行时行为时用 DAP 工具：dap_launch 启动程序、dap_set_breakpoint 下断点、dap_evaluate 查看变量值。
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
    `高级智能架构师 — 后端：Claude Opus 4.7（1M 上下文）子进程，拥有 LSP+DAP 全工具链，独立于你的判断做深度分析。根据 task_type 选择：
consult — 架构咨询。触发：拿不准的设计决策、技术选型、方案对比。必填 prompt=问题描述，可选 context=相关文件。
audit — SPEC审计。触发：SPEC/需求文档交付前。必填 prompt=SPEC路径，可选 dimensions=审计维度（不传则全7维度）。
review — 代码审查。触发：代码交付前、接手新模块。必填 prompt=审查目标路径，可选 focus=architecture|patterns|dependencies|complexity|all。
analyze — 深度分析。触发：修了2次还报错、全链路分析。必填 prompt=子系统描述，可选 context=入口文件、analysis_type=dataflow|callchain|state|all。`,
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

  // === Tool 4: worker_dispatch — 高并发低智力任务集群（DeepSeek） ===

  server.tool(
    'worker_dispatch',
    `高并发任务集群 — 后端：DeepSeek v4 Flash/Pro（无限并发），每个 worker 独立 Claude Code 实例。
mode=fast（默认）：机械化任务，Flash 模型，基础工具。适合：批量重命名、样板代码、简单重构、类型注解、测试桩、格式统一、find-and-replace。
mode=pro：有智能要求的任务，Pro 模型，LSP+DAP+WebSearch 全工具链，允许独立判断和代码理解。适合：需要理解代码语义的重构、跨文件依赖修改、需查引用后决策的修改、涉及类型推断的类型注解、需要理解业务逻辑的代码生成、需要搜索代码库上下文的任务。
决策信号：任务描述含"理解/分析/判断/依赖/语义/推断/上下文"→用 pro；纯字面量操作/模式固定→用 fast。`,
    {
      tasks: z.array(z.object({
        id: z.string().describe('任务标识（如 "rename-auth", "add-types"）'),
        description: z.string().describe('任务描述（给 worker 的完整指令，要足够具体）'),
        cwd: z.string().optional().describe('工作目录（不传则用全局 cwd）'),
        maxTurns: z.number().optional().describe('最大轮次（fast 默认100，pro 默认200）'),
      })).describe('要并行执行的任务列表'),
      concurrency: z.number().default(5).describe('并行 worker 数（无上限，按任务量设定，默认 5）'),
      cwd: z.string().optional().describe('默认工作目录'),
      mode: z.enum(['fast', 'pro']).default('fast').describe('fast=机械化任务（DeepSeek v4 Flash）| pro=有智能要求的任务（DeepSeek v4 Pro，全工具链，允许独立判断）'),
    },
    async (args) => {
      try { return await workerDispatch(args); }
      catch (err) { return { content: [{ type: 'text', text: `WORKER DISPATCH ERROR: ${err.message}\n${err.stack?.split('\n').slice(0, 3).join('\n')}` }] }; }
    },
  );

  // === Z3 SPEC Verification Tools ===
  registerZ3Tools(server);
}
