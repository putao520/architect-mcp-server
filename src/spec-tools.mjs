// spec-tools MCP 工具 — spec_validate + spec_status + spec_migrate
// spec_migrate: CC SDK 子 Agent 直接迁移 MD→HTML SPEC 2.0
// spec_validate/spec_status: CLI 包装

import { z } from 'zod';
import { spawn } from 'child_process';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { readdirSync, existsSync, readFileSync } from 'fs';
import { basename, join, dirname } from 'path';
import { loadGlmEnv } from './spawner.mjs';

const SPEC_BIN = 'spec';
const EXEC_TIMEOUT = 600_000;

// === CLI 包装 ===

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

// === CC SDK 迁移 Agent ===

const MIGRATE_SYSTEM_PROMPT = `你是 SPEC HTML 2.0 迁移引擎。将 Markdown SPEC 文件转换为标准 HTML SPEC 2.0。

## HTML SPEC 2.0 规范

文档骨架：
<!DOCTYPE html>
<html lang="zh-CN" data-spec-root>
<head>
  <meta charset="utf-8">
  <meta name="spec-file" content="文件名（无扩展名）">
  <meta name="spec-category" content="分类">
  <link rel="spec:depends" href="依赖文件.html">
  <script type="application/ld+json">
  { "@context":"https://spec.gsc.local/v1", "@type":"SpecDocument", "id":"文件名", "dependencies":[...], "children":[...] }
  </script>
</head>
<body>
  <header data-spec-header>
    <h1>标题</h1>
    <nav data-spec-breadcrumb><a href="./00-INDEX.html">SPEC</a> &gt; <span>文件名</span></nav>
  </header>
  <main data-spec-content>
    ... sections ...
  </main>
  <footer data-spec-footer>
    <address data-spec-ssot>SSOT 定义者：文件名.html</address>
  </footer>
</body>
</html>

Section 规则：
- 每个 ## 标题生成 <section id="s-X.Y" data-section="X.Y">
- REQ 标题：<section data-req="REQ-XXX-NNN" data-req-status="unknown" data-req-domain="xxx">
- 每个验收标准用 <p data-criterion>

Entity 表格：
<table data-entity-table="实体名">
  <tr><th>字段</th><th>类型</th><th>必填</th><th>约束</th><th>说明</th></tr>
  <tr data-field="name" data-type="string" data-required="true" data-constraints="PK">
    <td>name</td><td>string</td><td>是</td><td>PK</td><td>说明</td>
  </tr>
</table>
EntityRelations JSON-LD:
<script type="application/ld+json">
{ "@type": "EntityRelations", "entity": "Name", "relations": [{"type":"many-to-one","target":"Other","fk":"other_id"}] }
</script>

API 表格：
<table data-api-params>
  <tr><th>端点</th><th>方法</th><th>说明</th><th>角色</th></tr>
  <tr data-api="GET /api/users" data-api-method="GET" data-api-role="admin">
    <td>/api/users</td><td>GET</td><td>说明</td><td>admin</td>
  </tr>
</table>
ApiResponse JSON-LD 从 JSON 代码块提取。

状态机：
<section data-state-machine="名称">
  ... 转换表格 ...
  <script type="application/ld+json">
  { "@type": "StateMachine", "name":"...", "states":[...], "initialState":"...", "transitions":[...] }
  </script>
</section>

交叉引用：
<a href="./目标文件.html#锚点" data-xref-type="req|entity|api|section" data-xref-id="ID">文本</a>

## 工作流程
1. 用 Read 读取源 MD 文件
2. 理解完整语义结构（标题、表格、代码块、列表、链接）
3. 按规范生成完整 HTML
4. 用 Write 写入目标文件
5. 用 Bash 运行 spec validate <目标目录> 自校验
6. 如果 validate 报错，修复后重写
7. 完成后输出迁移结果摘要`;

async function migrateWithAgent(mdPath, specDir, outputDir) {
  const fileName = basename(mdPath).replace(/\.md(\.bak)?$/, '');
  const outputPath = join(outputDir || dirname(mdPath), `${fileName}.html`);
  const env = loadGlmEnv();
  let finalResult = null;
  const messages = [];

  const userPrompt = `迁移 ${mdPath} 到 HTML SPEC 2.0。

步骤：
1. 读取源文件：${mdPath}
2. 如果目标目录有其他 .html 文件，读取它们以获取交叉引用上下文
3. 生成符合 HTML SPEC 2.0 规范的完整 HTML
4. 写入目标文件：${outputPath}
5. 运行 spec validate ${outputDir || dirname(mdPath)} 验证
6. 如有错误则修复并重写

输出格式：最终写完文件后，输出一行摘要：MIGRATED: ${fileName} OK 或 MIGRATED: ${fileName} FAILED: 原因`;

  try {
    for await (const message of query({
      prompt: userPrompt,
      options: {
        systemPrompt: { type: 'text', text: MIGRATE_SYSTEM_PROMPT },
        cwd: specDir || dirname(mdPath),
        maxTurns: 50,
        permissionMode: 'bypassPermissions',
        allowedTools: ['Read', 'Write', 'Bash'],
        model: 'GLM-5.1',
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
    return { content: [{ type: 'text', text: `MIGRATE ERROR: ${err.message}` }], isError: true };
  }

  const success = finalResult?.subtype === 'success';
  const output = success ? messages.join('\n') : `Migration ended: ${finalResult?.subtype}\n${messages.join('\n')}`;

  return { content: [{ type: 'text', text: output }] };
}

// === 工具注册 ===

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
        switch (args.subcommand) {
          case 'single': {
            if (!args.mdFile) throw new Error('mdFile required for single');
            return await migrateWithAgent(args.mdFile, args.specDir || dirname(args.mdFile), args.outputDir);
          }
          case 'run': {
            if (!args.mdDir) throw new Error('mdDir required for run');
            const outputDir = args.outputDir || args.mdDir;
            const mdFiles = readdirSync(args.mdDir).filter(f => f.endsWith('.md'));
            const results = [];
            for (const f of mdFiles) {
              const mdPath = join(args.mdDir, f);
              const htmlName = f.replace(/\.md$/, '.html');
              const htmlPath = join(outputDir, htmlName);
              if (outputDir === args.mdDir && existsSync(htmlPath)) {
                const existing = readFileSync(htmlPath, 'utf8');
                if (existing.includes('</html>') && existing.includes('data-spec-root')) {
                  results.push(`  SKIP: ${f} (HTML exists)`);
                  continue;
                }
              }
              results.push(`\n--- Migrating: ${f} ---`);
              const result = await migrateWithAgent(mdPath, args.mdDir, outputDir);
              results.push(result.content[0].text);
            }
            return { content: [{ type: 'text', text: results.join('\n') }] };
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
