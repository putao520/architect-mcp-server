// spec-tools MCP 工具 — 统一入口
// 所有功能直接调用 spec/ 模块，不 spawn CLI

import { z } from 'zod';
import { buildSdkEnv } from './env.mjs';
import { parseSpecDir } from './spec/parse/html-parser.mjs';
import { validateAll } from './spec/validate/index.mjs';
import { validateLinks } from './spec/validate/links.mjs';
import { trackStatus } from './spec/status/tracker.mjs';
import { reportJson } from './spec/status/reporter.mjs';
import { verifyMigration } from './spec/migrate/verify.mjs';
import { migrateSingleFile, migrateBatch } from './spec/migrate/agent.mjs';
import { registerSpecAuditTools } from './spec/audit/index.mjs';
import { auditMaturity } from './spec/audit/maturity.mjs';
import { fixLinks } from './spec/transform/fix-links.mjs';
import { writeIndexHtml } from './spec/transform/index-builder.mjs';
import { formatValidationResult } from './spec/utils/format.mjs';

export function registerSpecTools(server) {
  registerSpecAuditTools(server);
  registerOpenApiTools(server);
  registerSchemaTools(server);

  // === MERGE-1: spec_lint (validate + health + fix) ===

  server.tool(
    'spec_lint',
    'SPEC 质量门控：validate/health/fix 统一入口。check=验证+链接检查 | health=验证+成熟度+状态 | fix=自动修复+重新验证',
    {
      dir: z.string().describe('SPEC 目录路径'),
      action: z.enum(['check', 'health', 'fix']).default('check').describe('check=验证 | health=健康报告 | fix=自动修复'),
      checkLinks: z.boolean().default(true).describe('[check] 是否同时检查交叉引用'),
      sourceDir: z.string().optional().describe('[health] 源码目录（Code 层覆盖率）'),
      fixLinksFlag: z.boolean().default(true).describe('[fix] 修复断链'),
      regenerateIndex: z.boolean().default(false).describe('[fix] 重新生成 00-INDEX.html'),
    },
    async (args) => {
      const { dir, action } = args;

      if (action === 'check') {
        const index = parseSpecDir(dir);
        const lines = [];
        const validateResult = validateAll(index);
        lines.push('=== SPEC VALIDATE ===');
        lines.push(formatValidationResult('Validate', validateResult));
        if (args.checkLinks) {
          const linksResult = validateLinks(index);
          lines.push('\n=== SPEC LINKS ===');
          lines.push(formatValidationResult('Links', linksResult));
        }
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }

      if (action === 'health') {
        const index = parseSpecDir(dir);
        const lines = [];

        const validateResult = validateAll(index);
        lines.push('=== VALIDATE ===');
        lines.push(formatValidationResult('Validate', validateResult));

        lines.push('\n=== MATURITY ===');
        const maturityResult = auditMaturity(index, { sourceDir: args.sourceDir });
        lines.push(`Maturity: ${(maturityResult.totals.maturity * 100).toFixed(1)}%`);
        lines.push(`  Design: ${(maturityResult.totals.designRate * 100).toFixed(1)}% | Code: ${maturityResult.totals.codeRate != null ? (maturityResult.totals.codeRate * 100).toFixed(1) + '%' : 'N/A'} | Test: ${(maturityResult.totals.testRate * 100).toFixed(1)}%`);
        lines.push(`  REQs: ${maturityResult.totals.specCount} | Domains: ${maturityResult.domains.length}`);

        lines.push('\n=== STATUS ===');
        const statusResult = trackStatus(index);
        lines.push(reportJson(statusResult));

        const hasErrors = validateResult.errors.length > 0;
        lines.push(`\n=== SUMMARY === ${hasErrors ? 'BLOCKED' : 'HEALTHY'} — ${validateResult.errors.length} errors, ${validateResult.warnings.length} warnings`);
        return { content: [{ type: 'text', text: lines.join('\n') }], isError: hasErrors };
      }

      if (action === 'fix') {
        const lines = [];

        if (args.fixLinksFlag) {
          const result = fixLinks(dir);
          lines.push(`Fix Links: ${result.totalFixed} links fixed (${result.anchors} anchors, ${result.reqs} REQs indexed)`);
        }

        if (args.regenerateIndex) {
          writeIndexHtml(dir);
          lines.push('Index: 00-INDEX.html regenerated');
        }

        const index = parseSpecDir(dir);
        const validateResult = validateAll(index);
        lines.push('\n=== POST-FIX VALIDATE ===');
        lines.push(formatValidationResult('Validate', validateResult));

        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }
    },
  );

  // === MERGE-2: spec_status (list + reindex) ===

  server.tool(
    'spec_status',
    'REQ 状态管理：list=查询所有 REQ 状态 | reindex=重新生成 00-INDEX.html',
    {
      dir: z.string().describe('SPEC 目录路径'),
      action: z.enum(['list', 'reindex']).default('list').describe('list=状态列表 | reindex=生成索引'),
    },
    (args) => {
      if (args.action === 'reindex') {
        writeIndexHtml(args.dir);
        return { content: [{ type: 'text', text: `00-INDEX.html generated in ${args.dir}` }] };
      }

      const index = parseSpecDir(args.dir);
      const result = trackStatus(index);
      const text = reportJson(result);
      return { content: [{ type: 'text', text }] };
    },
  );

  // === spec_migrate (unchanged, already has subcommand dispatch) ===

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
        const glmEnv = buildSdkEnv('glm');
        const env = { MODEL: 'GLM-5.1', env: glmEnv };

        switch (args.subcommand) {
          case 'single': {
            if (!args.mdFile) throw new Error('mdFile required for single');
            const result = await migrateSingleFile(args.mdFile, args.specDir || dirname(args.mdFile), args.outputDir, env);
            const summary = { file: result.file, success: result.success };
            if (result.error) summary.error = result.error;
            summary.output = result.output;
            return { content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }] };
          }
          case 'run': {
            if (!args.mdDir) throw new Error('mdDir required for run');
            const results = await migrateBatch(args.mdDir, args.outputDir || args.mdDir, env);
            const ok = results.filter(r => r.success && !r.skipped).length;
            const skip = results.filter(r => r.skipped).length;
            const fail = results.filter(r => !r.success).length;
            const summaries = results.map(r => {
              const s = { file: r.file, success: r.success };
              if (r.skipped) s.skipped = true;
              if (r.error) s.error = r.error;
              if (r.output) s.output = r.output;
              return s;
            });
            return { content: [{ type: 'text', text: `Done: ${ok} OK, ${skip} skipped, ${fail} FAIL\n${JSON.stringify(summaries, null, 2)}` }] };
          }
          case 'verify': {
            if (!args.mdDir || !args.htmlDir) throw new Error('mdDir and htmlDir required for verify');
            const result = verifyMigration(args.mdDir, args.htmlDir);
            return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
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
