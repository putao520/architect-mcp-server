#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { execSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { resolve, extname } from 'path';

// ── 环境变量加载（双模式：直接环境变量 > sh 脚本） ──

function loadEnv() {
  const envScript = process.env.ARCHITECT_ENV_SCRIPT || `${process.env.HOME}/kocode.sh`;
  const env = { ...process.env };

  // 直接设置优先
  if (process.env.ANTHROPIC_BASE_URL && process.env.ANTHROPIC_AUTH_TOKEN) {
    return env;
  }

  // 从 sh 脚本加载
  if (existsSync(envScript)) {
    try {
      const output = execSync(`bash -c "source '${envScript}' 2>/dev/null && env"`, {
        encoding: 'utf8',
        timeout: 5000,
      });
      for (const line of output.split('\n')) {
        const m = line.match(/^(ANTHROPIC_\w+|CLAUDE_\w+|ENABLE_\w+)=(.*)$/);
        if (m) env[m[1]] = m[2];
      }
    } catch { /* fallback to process.env */ }
  }

  return env;
}

const env = loadEnv();

// ── Tree-sitter 结构化解析 ──

let tsParsers = null;
const GRAMMAR_DIR = resolve(`${import.meta.dirname}`, 'grammars');

const LANG_MAP = {
  '.md': 'markdown', '.markdown': 'markdown',
  '.rs': 'rust', '.py': 'python', '.go': 'go',
  '.java': 'java', '.c': 'c', '.h': 'c',
  '.cpp': 'cpp', '.hpp': 'cpp', '.cxx': 'cpp',
  '.ts': 'typescript', '.tsx': 'typescript',
  '.js': 'typescript', '.mjs': 'typescript',
};

async function initTreeSitter() {
  if (tsParsers) return;
  try {
    const Parser = (await import('web-tree-sitter')).default;
    await Parser.init();
    tsParsers = { Parser, languages: {} };
    // Lazy load: languages are loaded on first use
  } catch { tsParsers = null; }
}

async function getParser(ext) {
  if (!tsParsers) return null;
  const langName = LANG_MAP[ext];
  if (!langName) return null;
  if (tsParsers.languages[langName]) return tsParsers.languages[langName];
  const wasmPath = resolve(GRAMMAR_DIR, `tree-sitter-${langName}.wasm`);
  if (!existsSync(wasmPath)) return null;
  try {
    const lang = await tsParsers.Parser.Language.load(wasmPath);
    tsParsers.languages[langName] = lang;
    return lang;
  } catch { return null; }
}

function extractMdStructure(content) {
  const sections = [];
  const reqIds = [];
  const codeBlocks = [];
  const tables = [];

  const lines = content.split('\n');
  let inCodeBlock = false;
  let inTable = false;
  let codeBlockLang = '';
  let codeBlockStart = 0;
  let tableRows = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // 标题
    const heading = line.match(/^(#{1,6})\s+(.+)/);
    if (heading) {
      if (inTable) { tables.push({ start: i - tableRows.length, rows: tableRows }); tableRows = []; inTable = false; }
      sections.push({ level: heading[1].length, title: heading[2], line: i + 1 });
      continue;
    }

    // REQ ID
    const req = line.match(/(?:REQ|req)[-_]?(\d+[\w.-]*)/i);
    if (req) reqIds.push({ id: `REQ-${req[1]}`, line: i + 1, text: line.trim() });

    // 代码块
    if (line.startsWith('```')) {
      if (!inCodeBlock) {
        inCodeBlock = true;
        codeBlockLang = line.slice(3).trim();
        codeBlockStart = i + 1;
      } else {
        codeBlocks.push({ lang: codeBlockLang || 'text', start: codeBlockStart, end: i + 1 });
        inCodeBlock = false;
      }
      continue;
    }

    // 表格
    if (line.includes('|') && line.trim().startsWith('|')) {
      if (!inTable) { inTable = true; tableRows = []; }
      tableRows.push(line);
    } else if (inTable) {
      tables.push({ start: i - tableRows.length + 1, rows: tableRows });
      tableRows = [];
      inTable = false;
    }
  }
  if (inTable && tableRows.length) tables.push({ start: lines.length - tableRows.length + 1, rows: tableRows });

  return { sections, reqIds, codeBlocks, tables };
}

function parseFileStructure(filePath) {
  const ext = extname(filePath).toLowerCase();
  if (!existsSync(filePath)) return null;

  const content = readFileSync(filePath, 'utf8');

  if (ext === '.md') {
    const mdResult = { type: 'markdown', ...extractMdStructure(content) };
    return mdResult;
  }

  // Try tree-sitter first, fallback to regex
  return parseSourceFile(filePath, ext, content);
}

async function parseFileStructureAsync(filePath) {
  const ext = extname(filePath).toLowerCase();
  if (!existsSync(filePath)) return null;

  const content = readFileSync(filePath, 'utf8');

  if (ext === '.md') {
    const lang = await getParser(ext);
    if (lang && tsParsers) {
      const parser = new tsParsers.Parser();
      parser.setLanguage(lang);
      const tree = parser.parse(content);
      const result = { type: 'markdown', ...extractMdStructure(content), astNodeCount: countNodes(tree.rootNode) };
      parser.delete();
      tree.delete();
      return result;
    }
    return { type: 'markdown', ...extractMdStructure(content) };
  }

  // Source files: try tree-sitter
  const lang = await getParser(ext);
  if (lang && tsParsers) {
    try {
      const parser = new tsParsers.Parser();
      parser.setLanguage(lang);
      const tree = parser.parse(content);
      const functions = [];
      const types = [];
      const imports = [];
      walkTree(tree.rootNode, (node) => {
        if (isFunctionNode(node)) functions.push({ name: getNodeName(node, content), line: node.startPosition.row + 1 });
        if (isTypeNode(node)) types.push({ name: getNodeName(node, content), line: node.startPosition.row + 1 });
        if (isImportNode(node)) imports.push({ text: node.text.slice(0, 80), line: node.startPosition.row + 1 });
      });
      parser.delete();
      tree.delete();
      return { type: 'source', ext, functions, types, imports };
    } catch { /* fallback */ }
  }

  return parseSourceFile(filePath, ext, content);
}

function parseSourceFile(filePath, ext, content) {
  const functions = [];
  const types = [];
  const imports = [];
  for (const line of content.split('\n')) {
    const fn = line.match(/^\s*(?:export\s+)?(?:async\s+)?(?:function|fn|def|pub\s+fn|pub\s+async\s+fn)\s+(\w+)/);
    if (fn) functions.push(fn[1]);

    const tp = line.match(/^\s*(?:export\s+)?(?:interface|type|struct|enum|class)\s+(\w+)/);
    if (tp) types.push(tp[1]);

    const imp = line.match(/^\s*(?:import|use|#include|require)\s+.*?(\w+)/);
    if (imp) imports.push(imp[1]);
  }
  return { type: 'source', ext, functions, types, imports };
}

function countNodes(node) {
  let count = 0;
  for (let i = 0; i < node.childCount; i++) count += countNodes(node.child(i));
  return 1 + count;
}

function walkTree(node, fn) {
  fn(node);
  for (let i = 0; i < node.childCount; i++) walkTree(node.child(i), fn);
}

function isFunctionNode(node) {
  const t = node.type;
  return t === 'function_declaration' || t === 'function_item' || t === 'function_definition'
    || t === 'method_declaration' || t === 'arrow_function' || t === 'generator_function_declaration';
}

function isTypeNode(node) {
  const t = node.type;
  return t === 'interface_declaration' || t === 'type_alias_declaration' || t === 'struct_item'
    || t === 'enum_declaration' || t === 'class_declaration' || t === 'type_definition';
}

function isImportNode(node) {
  const t = node.type;
  return t === 'import_statement' || t === 'import_declaration' || t === 'use_declaration'
    || t === 'extern_crate_item' || t === 'include_directive';
}

function getNodeName(node, content) {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child.type === 'identifier' || child.type === 'name' || child.type === 'type_identifier') {
      return content.slice(child.startIndex, child.endIndex);
    }
  }
  return '';
}

// ── System Prompts ──

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

// ── 核心 Spawn 逻辑 ──

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

async function spawnConsultation({ taskType, userPrompt, cwd, maxTurns }) {
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
    return {
      content: [{
        type: 'text',
        text: `ARCHITECT ERROR: ${err.message}\n\nPartial output:\n${messages.join('\n').slice(-8000)}`,
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

// ── 结构化上下文构建 ──

async function buildStructuredContext(files) {
  if (!files?.length) return '';
  const parts = [];
  for (const f of files) {
    const resolved = resolve(f);
    const parsed = await parseFileStructureAsync(resolved);
    if (parsed) parts.push(`File: ${resolved}\n${JSON.stringify(parsed, null, 2)}`);
  }
  return parts.length ? `\n\nStructured file context:\n${parts.join('\n\n')}` : '';
}

// ── MCP Server ──

const server = new McpServer({ name: 'architect-tools', version: '0.1.0' });

server.tool('architect_consult',
  '架构咨询。比你自己分析强：生成独立子 CC，拥有完整 agentic loop（读文件 + LSP 语义分析 + DAP 运行时验证 + WebSearch），独立完成深度分析后返回结构化建议。适用场景：架构选型、设计决策、技术方案对比、可行性评估。遇到"这个架构行不行""选 A 还是 B""怎么设计这个系统"类问题时，用这个工具比自己脑补可靠得多。',
  {
    prompt: z.string().describe('架构问题或设计决策描述'),
    cwd: z.string().optional().describe('项目工作目录（默认当前目录）'),
    context: z.array(z.string()).default([]).describe('相关文件路径，帮助子 CC 快速定位（如 ["src/main.rs","SPEC/01.md"]）'),
    maxTurns: z.number().optional().describe('子 CC 最大轮次，复杂问题用 3000+，简单问题用 500（默认 3000）'),
  },
  async ({ prompt, cwd, context, maxTurns }) => {
    const ctx = await buildStructuredContext(context);
    return spawnConsultation({ taskType: 'consult', userPrompt: prompt + ctx, cwd, maxTurns });
  }
);

server.tool('architect_audit',
  'SPEC 审计。比自己读 SPEC 检查强：生成独立子 CC，自动提取 SPEC 结构（标题层级/REQ 清单/代码块/表格），再结合代码库实际实现，从完整性/可行性/一致性/安全性/可测试性/性能/风险 7 个维度输出分级审计报告（Critical/Major/Minor/Info）。适用场景：SPEC 写完了要验收、实现前要确认设计是否可行、上线前要排查遗漏。',
  {
    specPath: z.string().describe('SPEC 文件或目录路径'),
    cwd: z.string().optional().describe('项目工作目录（默认当前目录）'),
    dimensions: z.array(z.string()).default([]).describe('只审计指定维度（如 ["完整性","安全性"]），不传则全 7 维度'),
    maxTurns: z.number().optional().describe('子 CC 最大轮次（默认 5000）'),
  },
  async ({ specPath, cwd, dimensions, maxTurns }) => {
    const resolved = resolve(specPath);
    const parsed = await parseFileStructureAsync(resolved);
    let userPrompt = `审计 SPEC: ${specPath}`;
    if (parsed) userPrompt += `\n\nSPEC 结构:\n${JSON.stringify(parsed, null, 2)}`;
    if (dimensions.length) userPrompt += `\n\n重点审计维度: ${dimensions.join('、')}`;
    return spawnConsultation({ taskType: 'audit', userPrompt, cwd, maxTurns: maxTurns || 5000 });
  }
);

server.tool('architect_review',
  '代码架构审查。比自己读代码评审强：生成独立子 CC，用 LSP 语义分析（hover/references/implementations/trace_origin）+ 代码阅读，从架构设计/设计模式/依赖关系/代码复杂度/SOLID 原则 5 个维度输出问题清单（按严重度排序）和改进建议。适用场景：重构前评估、代码审查、架构腐化检测、新接手项目摸底。',
  {
    target: z.string().describe('审查目标（文件路径、目录路径、或模块描述）'),
    cwd: z.string().optional().describe('项目工作目录（默认当前目录）'),
    focus: z.enum(['architecture', 'patterns', 'dependencies', 'complexity', 'all']).default('all').describe('审查重点'),
    maxTurns: z.number().optional().describe('子 CC 最大轮次（默认 4000）'),
  },
  async ({ target, cwd, focus, maxTurns }) => {
    const focusMap = {
      architecture: '架构设计', patterns: '设计模式',
      dependencies: '依赖关系', complexity: '代码复杂度', all: '全面审查',
    };
    const userPrompt = `审查目标: ${target}\n审查重点: ${focusMap[focus]}`;
    return spawnConsultation({ taskType: 'review', userPrompt, cwd, maxTurns: maxTurns || 4000 });
  }
);

server.tool('architect_analyze',
  '深度子系统分析。比 Grep 追调用链强 100 倍：生成独立子 CC，用 LSP 语义追踪（trace_origin 数据流溯源、references 精准调用方、implementations 接口实现）+ 可选 DAP 运行时验证，输出完整的调用图 + 数据流图 + 状态生命周期 + 性能热点 + 边界条件分析。适用场景：理解陌生子系统、排查跨模块 bug、性能瓶颈定位、安全审计前的攻击面梳理。',
  {
    subsystem: z.string().describe('子系统名称或描述（如 "用户认证流程"、"订单支付链路"）'),
    cwd: z.string().optional().describe('项目工作目录（默认当前目录）'),
    entryPoints: z.array(z.string()).default([]).describe('入口文件路径，帮助子 CC 快速定位起点'),
    analysisType: z.enum(['dataflow', 'callchain', 'state', 'all']).default('all').describe('分析类型'),
    maxTurns: z.number().optional().describe('子 CC 最大轮次（默认 4000）'),
  },
  async ({ subsystem, cwd, entryPoints, analysisType, maxTurns }) => {
    const typeMap = {
      dataflow: '数据流', callchain: '调用链', state: '状态管理', all: '全链路',
    };
    let userPrompt = `分析子系统: ${subsystem}\n分析类型: ${typeMap[analysisType]}`;
    if (entryPoints.length) {
      const ctx = await buildStructuredContext(entryPoints);
      userPrompt += `\n\n入口文件:\n${entryPoints.map(f => `- ${f}`).join('\n')}${ctx}`;
    }
    return spawnConsultation({ taskType: 'analyze', userPrompt, cwd, maxTurns: maxTurns || 4000 });
  }
);

// ── 启动 ──

async function main() {
  await initTreeSitter();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(err => {
  console.error('Architect MCP Server fatal:', err);
  process.exit(1);
});
