// spec-tools MCP 工具 — spec_validate + spec_status + spec_migrate
// spec_migrate: CC SDK Agent（复用 spec-tools/src/migrate/agent.mjs）
// spec_validate/spec_status: CLI 包装

import { z } from 'zod';
import { spawn } from 'child_process';
import { loadGlmEnv } from './spawner.mjs';
import { MIGRATE_SYSTEM_PROMPT, migrateSingleFile, migrateBatch } from '/home/putao/code/claude/spec-tools/src/migrate/agent.mjs';

const SPEC_BIN = 'spec';
const EXEC_TIMEOUT = 600_000;

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

export function registerSpecTools(server) {
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

  server.tool(
    'spec_status',
    'REQ 状态列表：查询所有 data-req 需求及其状态。',
    { dir: z.string().describe('SPEC 目录路径') },
    (args) => execSpec(['status', args.dir]),
  );

  server.tool(
    'spec_migrate',
    `SPEC MD→HTML 2.0 迁移。CC SDK Agent 智能迁移：自动理解语义、跨文件引用、大文件处理、自校验修复。
子命令：run（批量）| single（单文件）| verify（等价性验证）。`,
    {
      subcommand: z.enum(['run', 'single', 'verify']).describe('run=批量迁移 | single=单文件迁移 | verify=等价性验证'),
      mdDir: z.string().optional().describe('[run/verify] Markdown SPEC 目录路径'),
      mdFile: z.string().optional().describe('[single] 单个 MD 文件路径'),
      specDir: z.string().optional().describe('[single] SPEC 目录路径'),
      htmlDir: z.string().optional().describe('[verify] HTML SPEC 目录路径'),
      outputDir: z.string().optional().describe('[run/single] 输出目录'),
    },
    async (args) => {
      try {
        const glmEnv = loadGlmEnv();
        const env = { MODEL: 'GLM-5.1', env: glmEnv };

        switch (args.subcommand) {
          case 'single': {
            if (!args.mdFile) throw new Error('mdFile required for single');
            const result = await migrateSingleFile(args.mdFile, args.specDir || dirname(args.mdFile), args.outputDir, env);
            return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
          }
          case 'run': {
            if (!args.mdDir) throw new Error('mdDir required for run');
            const results = await migrateBatch(args.mdDir, args.outputDir || args.mdDir, env);
            const ok = results.filter(r => r.success && !r.skipped).length;
            const fail = results.filter(r => !r.success).length;
            return { content: [{ type: 'text', text: `Done: ${ok} OK, ${fail} FAIL\n${JSON.stringify(results, null, 2)}` }] };
          }
          case 'verify': {
            if (!args.mdDir || !args.htmlDir) throw new Error('mdDir and htmlDir required for verify');
            return await execSpec(['migrate', 'verify', args.mdDir, args.htmlDir]);
          }
        }
      } catch (err) {
        return { content: [{ type: 'text', text: `SPEC MIGRATE ERROR: ${err.message}` }], isError: true };
      }
    },
  );
}

function dirname(p) {
  const sep = p.lastIndexOf('/');
  return sep >= 0 ? p.slice(0, sep) : '.';
}
