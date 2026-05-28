// SPEC MD→HTML 2.0 迁移引擎 — CC SDK Agent
// 被 spec-tools CLI 和 architect MCP spec-tools.mjs 共用

import { query } from '@anthropic-ai/claude-agent-sdk';
import { readdirSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { basename, join, dirname } from 'node:path';

export const MIGRATE_SYSTEM_PROMPT = `你是 SPEC HTML 2.0 迁移引擎。将 Markdown SPEC 文件转换为标准 HTML SPEC 2.0。

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
- REQ 标题（包含 REQ-XXX-NNN 模式）：<section data-req="REQ-XXX-NNN" data-req-status="unknown" data-req-domain="xxx">
- 每个验收标准用 <p data-criterion>

Entity 表格（检测到字段/类型/必填列时使用）：
<table data-entity-table="实体名">
  <tr><th>字段</th><th>类型</th><th>必填</th><th>约束</th><th>说明</th></tr>
  <tr data-field="name" data-type="string" data-required="true" data-constraints="PK">
    <td>name</td><td>string</td><td>是</td><td>PK</td><td>说明</td>
  </tr>
</table>
如果检测到实体间关系，加 JSON-LD：
<script type="application/ld+json">
{ "@type": "EntityRelations", "entity": "Name", "relations": [{"type":"many-to-one","target":"Other","fk":"other_id"}] }
</script>

API 表格（检测到端点/方法列时使用）：
<table data-api-params>
  <tr><th>端点</th><th>方法</th><th>说明</th><th>角色</th></tr>
  <tr data-api="GET /api/users" data-api-method="GET" data-api-role="admin">
    <td>/api/users</td><td>GET</td><td>说明</td><td>admin</td>
  </tr>
</table>
如果检测到 JSON 代码块中的 API 响应示例，加 ApiResponse JSON-LD。

状态机（检测到 Mermaid stateDiagram 时使用）：
<section data-state-machine="名称">
  <script type="application/ld+json">
  { "@type": "StateMachine", "name":"...", "states":[...], "initialState":"...", "transitions":[...] }
  </script>
</section>

交叉引用规则：
- MD 中的 [文本](文件.md#锚点) → <a href="./文件.html#锚点" data-xref-type="类型" data-xref-id="ID">文本</a>
- xref-type 推断：REQ-开头 → req, 实体名 → entity, API路径 → api, 其他 → section
- 引用其他 SPEC 文件时，data-xref-id 使用目标文件中的 REQ/Entity/API ID

列表规则：
- 无序列表用 <ul><li> 包裹
- 有序列表用 <ol><li> 包裹

## 工作流程
1. 用 Read 读取源 MD 文件，理解完整语义结构
2. 如果目标目录已有 .html 文件，读取相关文件获取交叉引用上下文
3. 按规范生成完整 HTML — 确保所有 data-* 属性正确、JSON-LD 完整
4. 用 Write 写入目标文件
5. 用 Bash 运行 spec validate <目标目录> 自校验
6. 如果 validate 报错，分析错误、修复 HTML、重写
7. 完成后输出：MIGRATED: <文件名> OK 或 MIGRATED: <文件名> FAILED: 原因`;

export async function migrateSingleFile(mdPath, specDir, outputDir, env, maxTurns = 300) {
  const fileName = basename(mdPath).replace(/\.md(\.bak)?$/, '');
  const outDir = outputDir || dirname(mdPath);
  const outputPath = join(outDir, `${fileName}.html`);
  let finalResult = null;
  const logs = [];

  const userPrompt = `迁移 ${mdPath} 到 HTML SPEC 2.0。

步骤：
1. 读取源文件：${mdPath}
2. ${specDir ? `读取 ${specDir} 目录下已有 .html 文件获取交叉引用上下文` : '无已有 HTML 上下文'}
3. 生成符合 HTML SPEC 2.0 规范的完整 HTML
4. 写入目标文件：${outputPath}
5. 运行 spec validate ${outDir} 验证
6. 如有错误则修复并重写

输出：MIGRATED: ${fileName} OK 或 MIGRATED: ${fileName} FAILED: 原因`;

  try {
    for await (const message of query({
      prompt: userPrompt,
      options: {
        systemPrompt: { type: 'text', text: MIGRATE_SYSTEM_PROMPT },
        cwd: specDir || dirname(mdPath),
        maxTurns,
        permissionMode: 'bypassPermissions',
        allowedTools: ['Read', 'Write', 'Bash'],
        model: env?.ANTHROPIC_MODEL || 'GLM-5.1',
        effort: 'high',
        env,
      },
    })) {
      if (message.type === 'assistant' && message.message?.content) {
        for (const block of message.message.content) {
          if ('text' in block && block.text) logs.push(block.text);
        }
      } else if (message.type === 'result') {
        finalResult = message;
      }
    }
  } catch (err) {
    return { file: fileName, success: false, error: err.message, logs };
  }

  const success = finalResult?.subtype === 'success';
  const resultText = finalResult?.result || '';
  return {
    file: fileName,
    success,
    output: resultText || logs.join('\n'),
    logs,
  };
}

export async function migrateBatch(mdDir, outputDir, env) {
  const outDir = outputDir || mdDir;
  if (outDir !== mdDir) mkdirSync(outDir, { recursive: true });

  const mdFiles = readdirSync(mdDir).filter(f => f.endsWith('.md'));
  const results = [];

  for (const f of mdFiles) {
    const mdPath = join(mdDir, f);
    const htmlName = f.replace(/\.md$/, '.html');
    const htmlPath = join(outDir, htmlName);

    if (outDir === mdDir && existsSync(htmlPath)) {
      const existing = readFileSync(htmlPath, 'utf8');
      if (existing.includes('</html>') && existing.includes('data-spec-root')) {
        results.push({ file: f, success: true, skipped: true });
        console.log(`  SKIP: ${f} (HTML exists)`);
        continue;
      }
    }

    console.log(`  MIGRATING: ${f}...`);
    const result = await migrateSingleFile(mdPath, mdDir, outDir, env);
    results.push(result);
    console.log(`  ${result.success ? 'OK' : 'FAIL'}: ${f}`);
  }

  return results;
}
