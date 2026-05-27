// spec-tools CLI 包装 — 3 个 MCP 工具（validate 含 links, status, migrate）
// spec_graph 内部使用，不暴露给 AI
// spawn('spec', [...args]) → 捕获 stdout+stderr → 返回 MCP text response

import { z } from 'zod';
import { spawn } from 'child_process';

const SPEC_BIN = 'spec';
const EXEC_TIMEOUT = 600_000; // 10 分钟（批量迁移可能很慢）

export function execSpec(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(SPEC_BIN, args, { timeout: EXEC_TIMEOUT });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d; });
    proc.stderr.on('data', (d) => { stderr += d; });
    proc.on('close', (code) => {
      const output = stdout || stderr || '(no output)';
      if (code === 0) {
        resolve({ content: [{ type: 'text', text: output }] });
      } else {
        resolve({ content: [{ type: 'text', text: `EXIT CODE: ${code}\n${output}` }], isError: true });
      }
    });
    proc.on('error', (err) => reject(err));
  });
}

const SUBCOMMANDS = ['plan', 'index', 'run', 'single', 'verify'];

function validateMigrateArgs(args) {
  const { subcommand, mdDir, mdFile, specDir, htmlDir, outputDir } = args;
  switch (subcommand) {
    case 'plan':
    case 'index':
      if (!mdDir) throw new Error('mdDir required for plan/index');
      return ['migrate', subcommand, mdDir];
    case 'run':
      if (!mdDir) throw new Error('mdDir required for run');
      return outputDir
        ? ['migrate', 'run', mdDir, outputDir]
        : ['migrate', 'run', mdDir];
    case 'single':
      if (!mdFile || !specDir) throw new Error('mdFile and specDir required for single');
      return ['migrate', 'single', mdFile, specDir];
    case 'verify':
      if (!mdDir || !htmlDir) throw new Error('mdDir and htmlDir required for verify');
      return ['migrate', 'verify', mdDir, htmlDir];
    default:
      throw new Error(`Unknown subcommand: ${subcommand}. Valid: ${SUBCOMMANDS.join(', ')}`);
  }
}

export function registerSpecTools(server) {
  // Tool 1: spec_validate — 合并 validate + links
  server.tool(
    'spec_validate',
    'SPEC完整性验证 + 交叉引用检查：data-* 属性、JSON-LD 结构、data-xref 双向链接、断链检测。',
    {
      dir: z.string().describe('SPEC 目录路径'),
      checkLinks: z.boolean().default(true).describe('是否同时检查交叉引用（默认 true）'),
    },
    async (args) => {
      const results = [];
      const validateResult = await execSpec(['validate', args.dir]);
      results.push('=== SPEC VALIDATE ===');
      results.push(validateResult.content[0].text);
      if (args.checkLinks) {
        const linksResult = await execSpec(['links', args.dir]);
        results.push('\n=== SPEC LINKS ===');
        results.push(linksResult.content[0].text);
      }
      return { content: [{ type: 'text', text: results.join('\n') }] };
    },
  );

  // Tool 2: spec_status — REQ 状态查询
  server.tool(
    'spec_status',
    'REQ 状态列表：查询所有 data-req 需求及其状态。',
    { dir: z.string().describe('SPEC 目录路径') },
    (args) => execSpec(['status', args.dir]),
  );

  // Tool 3: spec_migrate — 迁移操作
  server.tool(
    'spec_migrate',
    `SPEC 迁移工具。子命令：plan（迁移计划）| index（预迁移索引）| run（批量迁移）| single（单文件迁移）| verify（等价性验证）。
Direct API（DeepSeek）快速 + Agent fallback（GLM-5.1 50轮）。assembler 100% 代码生成 HTML。`,
    {
      subcommand: z.enum(SUBCOMMANDS).describe('plan=迁移计划 | index=预迁移索引 | run=批量迁移 | single=单文件迁移 | verify=等价性验证'),
      mdDir: z.string().optional().describe('[plan/index/run/verify] Markdown SPEC 目录路径'),
      mdFile: z.string().optional().describe('[single] 单个 Markdown 文件路径'),
      specDir: z.string().optional().describe('[single] SPEC 目录路径（提供 xref 上下文）'),
      htmlDir: z.string().optional().describe('[verify] HTML SPEC 目录路径'),
      outputDir: z.string().optional().describe('[run] 输出目录（可选，默认覆盖 mdDir）'),
    },
    async (args) => {
      try {
        const cmdArgs = validateMigrateArgs(args);
        return await execSpec(cmdArgs);
      } catch (err) {
        return { content: [{ type: 'text', text: `SPEC MIGRATE ERROR: ${err.message}` }], isError: true };
      }
    },
  );
}
