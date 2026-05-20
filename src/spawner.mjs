import { query } from '@anthropic-ai/claude-agent-sdk';
import { buildStructuredContext, parseFileStructure } from './parser.mjs';
import { loadProvider } from './env.mjs';
import { resolve, join, dirname } from 'path';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { z } from 'zod';
import { spawn } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));

// === RWKV 推理服务客户端 ===
// 架构：rwkv-server.mjs 是独立单进程 HTTP 服务，所有 MCP server 实例共享
// MCP server 只做 HTTP 客户端调用，不加载模型

const RWKV_SERVER_PORT = parseInt(process.env.RWKV_SERVER_PORT || '19876', 10);
const RWKV_SERVER_URL = `http://127.0.0.1:${RWKV_SERVER_PORT}`;
const RWKV_PID_FILE = join(process.env.HOME || '/tmp', '.rwkv-server.json');

async function isServerAlive(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch { return false; }
}

async function ensureRwkvServer() {
  // 1. 检查已有服务（PID 文件 + health check）
  try {
    const pidInfo = JSON.parse(readFileSync(RWKV_PID_FILE, 'utf-8'));
    if (pidInfo?.port && await isServerAlive(pidInfo.port)) return;
  } catch {}

  // 2. 启动独立服务
  const child = spawn('node', [join(__dirname, 'rwkv-server.mjs')], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env },
  });
  child.unref();

  // 3. 等待就绪（模型加载可能需要 10-30s）
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 1000));
    if (await isServerAlive(RWKV_SERVER_PORT)) return;
  }
  throw new Error('RWKV server failed to start within 60s');
}

async function callRwkvServer(endpoint, args) {
  await ensureRwkvServer();
  const res = await fetch(`${RWKV_SERVER_URL}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`RWKV server ${res.status}: ${text}`);
  }
  return res.json();
}

// === Architect Consultation 子 CC（Claude SDK） ===

const DEFAULT_MAX_TURNS = parseInt(process.env.ARCHITECT_MAX_TURNS || '3000', 10);

// === Worker Agent — 机械化低智力任务集群（DeepSeek v4 Flash） ===
// 定位：architect_*=Opus（贵/高智力）| RWKV=本地（免费/抽象推理）| worker=DeepSeek（便宜/快速/集群并行）

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

const WORKER_SYSTEM = `
你是机械化任务执行器。严格按指令执行，不做设计决策。
- 不在要求时添加注释或文档
- 只输出执行结果和变更摘要
- 遇到歧义按最简方案处理
- 不修改指令未提及的文件`;

async function runWorkerTask(task, baseCwd, env) {
  const messages = [];
  let finalResult = null;

  try {
    for await (const message of query({
      prompt: task.description,
      options: {
        systemPrompt: { type: 'preset', preset: 'claude_code', append: WORKER_SYSTEM },
        cwd: task.cwd || baseCwd || process.cwd(),
        maxTurns: task.maxTurns || 100,
        permissionMode: 'bypassPermissions',
        allowedTools: WORKER_TOOLS,
        model: 'deepseek-v4-flash[1m]',
        effort: 'low',
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
  const { tasks, concurrency = 5, cwd } = args;
  const env = loadWorkerEnv();

  const results = [];
  const maxConcurrency = Math.min(concurrency, 10);

  for (let i = 0; i < tasks.length; i += maxConcurrency) {
    const batch = tasks.slice(i, i + maxConcurrency);
    const batchResults = await Promise.all(
      batch.map(task => runWorkerTask({ ...task, cwd: task.cwd || cwd }, cwd, env))
    );
    results.push(...batchResults);
  }

  const out = [`WORKER DISPATCH COMPLETE`, `Tasks: ${tasks.length} | Concurrency: ${maxConcurrency} | Engine: DeepSeek v4 Flash`, ''];
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
  // Architect 工具组（Claude SDK 子 CC 进程）
  const tools = [
    {
      name: 'architect_consult',
      description: '架构咨询 — 遇到拿不准的设计决策？升级给架构师。像真实团队里你把难题抛给资深架构师一样：技术选型、系统设计、方案对比、可行性评估，你描述问题和上下文，独立架构师（Opus 4.7 + 1M 上下文）深入代码库调研后给出结构化建议。触发时机：你试了 2-3 次还拿不定主意、用户让你评估方案、设计决策影响面大你不敢独自拍板、建模/选库/定协议等需要专家意见。',
      schema: {
        prompt: { type: 'string', describe: '架构问题或设计决策描述' },
        cwd: { type: 'string', optional: true, describe: '项目工作目录（默认当前目录）' },
        context: { type: 'array', items: { type: 'string' }, default: [], describe: '相关文件路径，帮助子 CC 快速定位（如 ["src/main.rs","SPEC/01.md"]）' },
        maxTurns: { type: 'number', optional: true, describe: '子 CC 最大轮次，复杂问题用 3000+，简单问题用 500（默认 3000）' },
      },
      defaultTurns: 3000,
      buildPrompt: async (args) => {
        const ctx = await buildStructuredContext(args.context);
        return args.prompt + ctx;
      },
    },
    {
      name: 'architect_audit',
      description: 'SPEC 审计 — 你的 SPEC 写完了？先过架构师这关再实现。你作为主 CC 设计 SPEC 后，把它交给独立架构师（子 Opus 4.7 + max effort）审查：自动解析 SPEC 结构，对照代码库逐条验证，输出 Critical/Major/Minor/Info 分级审计报告。像真实团队里架构师 review 你的设计文档一样——不是你自己检查自己。铁律：涉及 SPEC 设计、需求文档撰写、新功能规划等产出物，交付前必须先审计。',
      schema: {
        specPath: { type: 'string', describe: 'SPEC 文件或目录路径' },
        cwd: { type: 'string', optional: true, describe: '项目工作目录（默认当前目录）' },
        dimensions: { type: 'array', items: { type: 'string' }, default: [], describe: '只审计指定维度（如 ["完整性","安全性"]），不传则全 7 维度' },
        maxTurns: { type: 'number', optional: true, describe: '子 CC 最大轮次（默认 5000）' },
      },
      defaultTurns: 5000,
      buildPrompt: async (args) => {
        const resolved = resolve(args.specPath);
        const parsed = await parseFileStructure(resolved);
        let prompt = `审计 SPEC: ${args.specPath}`;
        if (parsed) prompt += `\n\nSPEC 结构:\n${JSON.stringify(parsed, null, 2)}`;
        if (args.dimensions?.length) prompt += `\n\n重点审计维度: ${args.dimensions.join('、')}`;
        return prompt;
      },
    },
    {
      name: 'architect_review',
      description: '代码架构审查 — 你写的代码？架构师来 Review。像真实团队里 Senior 审 Junior 的代码一样：独立架构师用 LSP 全链路分析你的代码（hover 类型、references 引用、implementations 实现、trace_origin 数据流），输出 5 维度评分 + 问题清单 + 改进建议。触发时机：写完一批代码准备交付前、重构前要评估现状、接手新模块要摸底质量、怀疑架构腐化需要确认——你自己审自己容易有盲区，让独立专家来看。',
      schema: {
        target: { type: 'string', describe: '审查目标（文件路径、目录路径、或模块描述）' },
        cwd: { type: 'string', optional: true, describe: '项目工作目录（默认当前目录）' },
        focus: { type: 'enum', enum: ['architecture', 'patterns', 'dependencies', 'complexity', 'all'], default: 'all', describe: '审查重点' },
        maxTurns: { type: 'number', optional: true, describe: '子 CC 最大轮次（默认 4000）' },
      },
      defaultTurns: 4000,
      buildPrompt: async (args) => {
        const focusMap = { architecture: '架构设计', patterns: '设计模式', dependencies: '依赖关系', complexity: '代码复杂度', all: '全面审查' };
        return `审查目标: ${args.target}\n审查重点: ${focusMap[args.focus]}`;
      },
    },
    {
      name: 'architect_analyze',
      description: '深度分析 — 你排查不明白的 bug/子系统/性能问题？升级给架构师。真实团队里的典型场景：你修了几次没修好 → 架构师来定位根因；你不理解某个子系统的调用链和数据流 → 架构师出全链路分析报告。独立架构师用 LSP 语义追踪（trace_origin/references/implementations）+ DAP 运行时断点验证，输出调用图+数据流图+状态生命周期+性能热点+边界条件。触发时机：修了 2 次以上还报错、需要全链路理解陌生模块、性能瓶颈定位、安全审计前攻击面梳理。',
      schema: {
        subsystem: { type: 'string', describe: '子系统名称或描述（如 "用户认证流程"、"订单支付链路"）' },
        cwd: { type: 'string', optional: true, describe: '项目工作目录（默认当前目录）' },
        entryPoints: { type: 'array', items: { type: 'string' }, default: [], describe: '入口文件路径，帮助子 CC 快速定位起点' },
        analysisType: { type: 'enum', enum: ['dataflow', 'callchain', 'state', 'all'], default: 'all', describe: '分析类型' },
        maxTurns: { type: 'number', optional: true, describe: '子 CC 最大轮次（默认 4000）' },
      },
      defaultTurns: 4000,
      buildPrompt: async (args) => {
        const typeMap = { dataflow: '数据流', callchain: '调用链', state: '状态管理', all: '全链路' };
        let prompt = `分析子系统: ${args.subsystem}\n分析类型: ${typeMap[args.analysisType]}`;
        if (args.entryPoints?.length) {
          const ctx = await buildStructuredContext(args.entryPoints);
          prompt += `\n\n入口文件:\n${args.entryPoints.map(f => `- ${f}`).join('\n')}${ctx}`;
        }
        return prompt;
      },
    },
  ];

  for (const tool of tools) {
    const zSchema = {};
    for (const [key, def] of Object.entries(tool.schema)) {
      const { type, describe, optional, default: dflt, items, enum: enumVals } = def;
      let field;
      if (type === 'string') field = z.string();
      else if (type === 'number') field = z.number();
      else if (type === 'array') field = z.array(z.string());
      else if (type === 'enum') field = z.enum(enumVals);
      if (optional) field = field.optional();
      if (dflt !== undefined) field = field.default(dflt);
      field = field.describe(describe);
      zSchema[key] = field;
    }

    server.tool(tool.name, tool.description, zSchema, async (args) => {
      const userPrompt = await tool.buildPrompt(args);
      return spawnConsultation({
        taskType: tool.name.replace('architect_', ''),
        userPrompt,
        cwd: args.cwd,
        maxTurns: args.maxTurns || tool.defaultTurns,
        env,
      });
    });
  }

  // Abstract Reasoning — 本地 RWKV-7 推理（HTTP 客户端 → 独立 rwkv-server 进程）
  server.tool(
    'abstract_reasoning',
    '高维抽象推理引擎 — 本地 RWKV-7 2.9B 模型推理，不消耗 API 额度。适用场景：(1) 任务涉及文件总大小超过你上下文能处理的范围（如 10+ 文件、SPEC 全量分析），本引擎可一次性读取所有文件并推理；(2) 需要对大量代码/文档做多维度并行分析（如同时分析数据流+风险+架构），你设计 DAG（有向无环图），引擎并行执行独立节点；(3) 需要独立于你的判断做第二意见推理——避免自己的分析盲区。使用方式：你设计 DAG 节点和依赖关系，引擎内部用 Think mode 推理 + WKV state 共享 + 拓扑排序并行执行 → 返回综合结论。不适用：单文件阅读、简单问答、<3 个文件的分析。',
    {
      problem: z.string().describe('整体问题描述（你要解决什么）'),
      files: z.array(z.string()).describe('要读取的文件/目录路径列表（作为推理上下文，支持目录递归）'),
      context: z.string().optional().describe('额外内联上下文（如 SPEC 摘要、约束条件）'),
      nodes: z.array(z.object({
        id: z.string().describe('节点唯一标识（如 "dataflow", "risk"）'),
        query: z.string().describe('该节点要推理的具体问题'),
        type: z.enum(['abstract', 'decompose', 'dataflow', 'risk', 'structure']).default('abstract').describe('推理类型：abstract=高维抽象 | decompose=问题分解 | dataflow=数据流追踪 | risk=风险评估 | structure=结构分析'),
      })).describe('DAG 推理节点列表'),
      deps: z.array(z.object({
        from: z.string().describe('前置节点 ID'),
        to: z.string().describe('依赖节点 ID（需要 from 的结果才能推理）'),
      })).default([]).describe('依赖边：to 依赖 from 的推理结果'),
      cwd: z.string().optional().describe('文件路径基准目录'),
    },
    async (args) => {
      try {
        return await callRwkvServer('/execute-dag', args);
      } catch (err) {
        return { content: [{ type: 'text', text: `ABSTRACT REASONING ERROR: ${err.message}\n${err.stack?.split('\n').slice(0, 5).join('\n')}` }] };
      }
    },
  );

  // Deep Read — 超大文件读取理解（RWKV 线性注意力，无上下文窗口限制）
  server.tool(
    'deep_read',
    '超大文件深度阅读 — 利用本地 RWKV-7 模型的线性注意力机制（无上下文窗口限制）读取和理解超大文件。当文件太大超过了你的上下文窗口时使用此工具。场景：(1) 单个文件 >500KB，你无法完整读入上下文；(2) 需要从大日志/数据文件中提取特定信息；(3) 需要对超大 SPEC/文档做摘要或分析；(4) 多个大文件合并理解。引擎会分块将整个文件 feed 进 RWKV 的 WKV state（固定 20.63MB），然后用 Think mode 回答你的问题。不消耗 API 额度。',
    {
      files: z.array(z.string()).describe('要读取的文件/目录路径列表（支持超大文件，单文件上限 100MB）'),
      question: z.string().describe('你想要从文件中了解的问题'),
      mode: z.enum(['extract', 'summarize', 'analyze', 'qa']).default('qa').describe('读取模式：extract=精确提取信息 | summarize=生成摘要 | analyze=深度分析 | qa=问答（默认）'),
      cwd: z.string().optional().describe('文件路径基准目录'),
      maxTokens: z.number().optional().describe('最大处理 token 数（默认 500000，约 500KB-2MB 文本）'),
    },
    async (args) => {
      try {
        return await callRwkvServer('/deep-read', args);
      } catch (err) {
        return { content: [{ type: 'text', text: `DEEP READ ERROR: ${err.message}\n${err.stack?.split('\n').slice(0, 5).join('\n')}` }] };
      }
    },
  );

  // Project Memory — 多级项目摘要 + State 持久化（秒级加载，不用重新读文件）
  server.tool(
    'project_save',
    '项目记忆保存 — 扫描项目目录，生成三级摘要（文件级→模块级→项目级），将 RWKV state 序列化存盘。后续用 project_query 直接加载 state 秒级回答问题，不用重新读文件。设置 watch=true 可同时建立监控基线（用于 watch_check 增量变更分析）。场景：首次分析项目、项目结构有重大变更需要更新记忆。',
    {
      project: z.string().describe('项目名称（如 "architect-mcp-server"）'),
      path: z.string().describe('项目根目录绝对路径'),
      exclude: z.array(z.string()).default([]).describe('排除的目录/文件模式'),
      watch: z.boolean().default(false).describe('同时建立监控基线（用于 watch_check 增量分析）'),
    },
    async (args) => {
      try { return await callRwkvServer('/project-save', args); }
      catch (err) { return { content: [{ type: 'text', text: `PROJECT SAVE ERROR: ${err.message}` }] }; }
    },
  );

  server.tool(
    'project_query',
    '项目记忆查询 — 加载已保存的项目 RWKV state，直接回答问题（秒级，不重新读文件）。必须先用 project_save 建立记忆。场景：快速回答关于项目架构、模块职责、接口设计等问题。',
    {
      project: z.string().describe('项目名称'),
      question: z.string().describe('要问的问题'),
    },
    async (args) => {
      try { return await callRwkvServer('/project-query', args); }
      catch (err) { return { content: [{ type: 'text', text: `PROJECT QUERY ERROR: ${err.message}` }] }; }
    },
  );

  server.tool(
    'project_list',
    '列出所有已保存的项目记忆。查看有哪些项目已经建立了 RWKV state 记忆。',
    {},
    async () => {
      try { return await callRwkvServer('/project-list', {}); }
      catch (err) { return { content: [{ type: 'text', text: `PROJECT LIST ERROR: ${err.message}` }] }; }
    },
  );

  // Multi Lens — 多视角并行分析
  server.tool(
    'multi_lens',
    '多视角并行分析 — 同一份代码/文档，从不同专业角度并行分析。利用 RWKV state 分叉零成本特性：读一次文件 → 分叉 N 个 session → 每个用不同角色（安全/性能/可维护性/架构/可靠性）独立 Think mode 分析 → 交叉对比综合。场景：方案评审需要多维度评估、架构决策需要权衡利弊、交付前多角度质量检查。',
    {
      files: z.array(z.string()).describe('要分析的文件/目录路径'),
      question: z.string().describe('分析的核心问题'),
      lenses: z.array(z.enum(['security', 'performance', 'maintainability', 'architecture', 'reliability'])).default(['security', 'performance', 'architecture']).describe('分析视角列表'),
      extraLens: z.string().optional().describe('自定义视角描述（如 "从团队协作效率角度"）'),
      cwd: z.string().optional().describe('文件路径基准目录'),
    },
    async (args) => {
      try { return await callRwkvServer('/multi-lens', args); }
      catch (err) { return { content: [{ type: 'text', text: `MULTI LENS ERROR: ${err.message}` }] }; }
    },
  );

  // Diff Read — 长文本对比
  server.tool(
    'diff_read',
    '长文本对比分析 — 两个文件/目录版本的对比分析。利用 RWKV 双路独立 state：A 和 B 各自 feed → 各自生成结构化摘要 → 第三路 session 做差异对比。场景：新旧版本对比、分支差异分析、两套实现方案对比。文件太大你上下文放不下时使用。',
    {
      filesA: z.array(z.string()).describe('对比方 A 的文件/目录路径'),
      filesB: z.array(z.string()).describe('对比方 B 的文件/目录路径'),
      question: z.string().describe('要对比的问题（如 "两个版本的架构差异"）'),
      labelA: z.string().default('Version A').describe('A 方标签'),
      labelB: z.string().default('Version B').describe('B 方标签'),
      cwd: z.string().optional().describe('文件路径基准目录'),
    },
    async (args) => {
      try { return await callRwkvServer('/diff-read', args); }
      catch (err) { return { content: [{ type: 'text', text: `DIFF READ ERROR: ${err.message}` }] }; }
    },
  );

  // Watch Check — 增量监控（≥10min 间隔，仅闲时）
  server.tool(
    'watch_check',
    '增量变更分析 — 检查项目文件变化（对比 checksum），只对变更部分做增量 feed + 多轮 Think 分析。必须先用 project_save(watch=true) 建立基线。约束：最少 10 分钟间隔，仅闲时执行。未到间隔会返回状态信息和剩余等待时间。',
    {
      project: z.string().describe('项目名称'),
      question: z.string().default('分析最近的变更').describe('要分析的变更问题'),
    },
    async (args) => {
      try { return await callRwkvServer('/watch-check', args); }
      catch (err) { return { content: [{ type: 'text', text: `WATCH CHECK ERROR: ${err.message}` }] }; }
    },
  );

  // Worker Dispatch — 机械化低智力任务集群（DeepSeek v4 Flash）
  server.tool(
    'worker_dispatch',
    '机械化任务集群执行器 — 用便宜的 DeepSeek v4 Flash 模型并行执行批量低智力任务。从 ~/.gsc/providers/deepseek.json 加载 API 配置。适合：批量重命名/移动文件、生成样板代码、简单重构（LSP 辅助）、批量添加类型注解、生成测试桩、文档生成、格式统一、find-and-replace 等。不适合：架构设计、复杂 bug 分析、需要深度推理的任务（用 architect_* 或 abstract_reasoning）。集群模式：多个任务并行执行，默认 5 并发。',
    {
      tasks: z.array(z.object({
        id: z.string().describe('任务标识（如 "rename-auth", "add-types"）'),
        description: z.string().describe('任务描述（给 worker 的完整指令，要足够具体）'),
        cwd: z.string().optional().describe('工作目录（不传则用全局 cwd）'),
        maxTurns: z.number().optional().describe('最大轮次（默认 100，简单任务用 20-50）'),
      })).describe('要并行执行的任务列表'),
      concurrency: z.number().default(5).describe('并行 worker 数（1-10，默认 5）'),
      cwd: z.string().optional().describe('默认工作目录'),
    },
    async (args) => {
      try { return await workerDispatch(args); }
      catch (err) { return { content: [{ type: 'text', text: `WORKER DISPATCH ERROR: ${err.message}\n${err.stack?.split('\n').slice(0, 3).join('\n')}` }] }; }
    },
  );
}
