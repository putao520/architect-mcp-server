import { query } from '@anthropic-ai/claude-agent-sdk';
import { buildStructuredContext, parseFileStructure } from './parser.mjs';
import { resolve } from 'path';
import { z } from 'zod';

const DEFAULT_MAX_TURNS = parseInt(process.env.ARCHITECT_MAX_TURNS || '3000', 10);

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

export async function spawnConsultation({ taskType, userPrompt, cwd, maxTurns, env }) {
  const effectiveCwd = cwd || process.cwd();
  const turns = maxTurns || DEFAULT_MAX_TURNS;

  const messages = [];
  let finalResult = null;

  try {
    for await (const message of query({
      prompt: userPrompt,
      options: {
        systemPrompt: { type: 'preset', preset: 'claude_code', append: SYSTEM_PROMPTS[taskType] },
        cwd: effectiveCwd,
        maxTurns: turns,
        permissionMode: 'bypassPermissions',
        allowedTools: ALL_TOOLS,
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

// 工具注册工厂
export function registerTools(server, env) {
  const tools = [
    {
      name: 'architect_consult',
      description: '架构咨询。比你自己分析强：生成独立子 CC，拥有完整 agentic loop（读文件 + LSP 语义分析 + DAP 运行时验证 + WebSearch），独立完成深度分析后返回结构化建议。适用场景：架构选型、设计决策、技术方案对比、可行性评估。遇到"这个架构行不行""选 A 还是 B""怎么设计这个系统"类问题时，用这个工具比自己脑补可靠得多。',
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
      description: 'SPEC 审计。比自己读 SPEC 检查强：生成独立子 CC，自动提取 SPEC 结构（标题层级/REQ 清单/代码块/表格），再结合代码库实际实现，从完整性/可行性/一致性/安全性/可测试性/性能/风险 7 个维度输出分级审计报告（Critical/Major/Minor/Info）。适用场景：SPEC 写完了要验收、实现前要确认设计是否可行、上线前要排查遗漏。',
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
      description: '代码架构审查。比自己读代码评审强：生成独立子 CC，用 LSP 语义分析（hover/references/implementations/trace_origin）+ 代码阅读，从架构设计/设计模式/依赖关系/代码复杂度/SOLID 原则 5 个维度输出问题清单（按严重度排序）和改进建议。适用场景：重构前评估、代码审查、架构腐化检测、新接手项目摸底。',
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
      description: '深度子系统分析。比 Grep 追调用链强 100 倍：生成独立子 CC，用 LSP 语义追踪（trace_origin 数据流溯源、references 精准调用方、implementations 接口实现）+ 可选 DAP 运行时验证，输出完整的调用图 + 数据流图 + 状态生命周期 + 性能热点 + 边界条件分析。适用场景：理解陌生子系统、排查跨模块 bug、性能瓶颈定位、安全审计前的攻击面梳理。',
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
}
