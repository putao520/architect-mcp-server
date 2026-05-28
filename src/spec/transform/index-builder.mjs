import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { basename, join, relative, dirname } from 'node:path';
import { parseSpecDir, parseSpecFile } from '../parse/html-parser.mjs';
import { inferCategory, inferTitle, CATEGORY_LABELS } from '../utils/constants.mjs';

function categoryLabel(cat) {
  return CATEGORY_LABELS[cat] || cat || '—';
}

function countReqs(doc) {
  return doc.reqs?.length || 0;
}

function countEntities(doc) {
  return doc.entities?.length || 0;
}

function countApis(doc) {
  return doc.apis?.length || 0;
}

function countTests(doc) {
  return doc.tests?.length || 0;
}

function countStateMachines(doc) {
  return doc.stateMachines?.length || 0;
}

export function buildIndexData(specDir) {
  const index = parseSpecDir(specDir);
  const documents = [];

  for (const doc of index.docs) {
    const relPath = relative(specDir, doc.filePath).replace(/\\/g, '/');
    const category = doc.meta?.category || inferCategory(doc.fileName);
    const title = doc.meta?.title || inferTitle(doc.fileName);
    const children = index.childrenMap.get(doc.fileName) || [];

    documents.push({
      id: doc.fileName,
      relPath,
      category,
      title,
      reqs: countReqs(doc),
      entities: countEntities(doc),
      apis: countApis(doc),
      tests: countTests(doc),
      stateMachines: countStateMachines(doc),
      children: children.map(c => {
        const childDoc = index.fileMap.get(c);
        return {
          id: childDoc?.fileName || c,
          relPath: childDoc ? relative(specDir, childDoc.filePath).replace(/\\/g, '/') : c,
        };
      }),
      isSubfile: doc.subfileInfo?.isSubfile || false,
      parent: doc.subfileInfo?.parent || null,
    });
  }

  documents.sort((a, b) => {
    if (a.isSubfile !== b.isSubfile) return a.isSubfile ? 1 : -1;
    return a.relPath.localeCompare(b.relPath);
  });

  return { documents, specDir };
}

export function generateIndexHtml(specDir) {
  const { documents } = buildIndexData(specDir);

  const mainDocs = documents.filter(d => !d.isSubfile);
  const subDocs = documents.filter(d => d.isSubfile);

  const docEntries = mainDocs.map(d => {
    const childrenJson = d.children.length > 0
      ? d.children.map(c => `"${c.id}"`).join(',')
      : '';
    const childrenField = childrenJson ? `,"children":[${childrenJson}]` : '';
    const reqsField = d.reqs > 0 ? `,"reqs":${d.reqs}` : '';
    const entitiesField = d.entities > 0 ? `,"entities":${d.entities}` : '';
    const apisField = d.apis > 0 ? `,"apis":${d.apis}` : '';
    const testsField = d.tests > 0 ? `,"tests":${d.tests}` : '';
    return `{"id":"${d.id}","category":"${d.category}","title":"${d.title}"${childrenField}${reqsField}${entitiesField}${apisField}${testsField}}`;
  }).join(',\n      ');

  const view41Rows = mainDocs
    .filter(d => d.category.startsWith('4+1'))
    .map(d => rowHtml(d))
    .join('\n        ');

  const supportRows = mainDocs
    .filter(d => !d.category.startsWith('4+1') && d.category !== 'index')
    .map(d => rowHtml(d))
    .join('\n        ');

  const statsLine = mainDocs.reduce((acc, d) => ({
    reqs: acc.reqs + d.reqs,
    entities: acc.entities + d.entities,
    apis: acc.apis + d.apis,
    tests: acc.tests + d.tests,
  }), { reqs: 0, entities: 0, apis: 0, tests: 0 });

  const now = new Date().toISOString().split('T')[0];

  return `<!DOCTYPE html>
<html lang="zh-CN" data-spec-root>
<head>
  <meta charset="utf-8">
  <meta name="spec-file" content="00-INDEX">
  <meta name="spec-category" content="index">
  <title>SPEC 设计文档目录</title>
  <script type="application/ld+json">
  { "@context":"https://spec.gsc.local/v1", "@type":"SpecIndex",
    "generated":"${now}",
    "stats":{"reqs":${statsLine.reqs},"entities":${statsLine.entities},"apis":${statsLine.apis},"tests":${statsLine.tests}},
    "documents":[
      ${docEntries}
    ]
  }
  </script>
</head>
<body>
  <header data-spec-header>
    <h1>SPEC 设计文档目录</h1>
    <p>共 ${mainDocs.length} 个主文件、${subDocs.length} 个子文件 | REQ: ${statsLine.reqs} | Entity: ${statsLine.entities} | API: ${statsLine.apis} | TEST: ${statsLine.tests}</p>
  </header>
  <main data-spec-content>
    <section id="s1">
      <h2>4+1 架构视图</h2>
      <table data-index-table="4+1">
        <tr><th>文件</th><th>视图</th><th>设计产物</th><th>子文件</th></tr>
        ${view41Rows}
      </table>
    </section>
    <section id="s2">
      <h2>关联文档</h2>
      <table data-index-table="support">
        <tr><th>文件</th><th>类别</th><th>设计产物</th><th>子文件</th></tr>
        ${supportRows}
      </table>
    </section>
  </main>
  <footer data-spec-footer>
    <p>自动生成于 ${now}</p>
  </footer>
</body>
</html>`;
}

function rowHtml(d) {
  const artifacts = summarizeArtifacts(d);
  const childLinks = d.children.map(c =>
    `<a href="./${c.relPath}" data-xref-type="spec-subfile">${c.id}</a>`
  ).join(' ') || '—';
  const category = categoryLabel(d.category);
  return `<tr>
  <td><a href="./${d.relPath}" data-xref-type="spec-file">${d.id}</a></td>
  <td>${category}</td>
  <td>${artifacts}</td>
  <td>${childLinks}</td>
</tr>`;
}

function summarizeArtifacts(d) {
  const parts = [];
  if (d.reqs > 0) parts.push(`REQ ×${d.reqs}`);
  if (d.entities > 0) parts.push(`Entity ×${d.entities}`);
  if (d.apis > 0) parts.push(`API ×${d.apis}`);
  if (d.tests > 0) parts.push(`TEST ×${d.tests}`);
  if (d.stateMachines > 0) parts.push(`SM ×${d.stateMachines}`);
  return parts.join('、') || '—';
}

export function writeIndexHtml(specDir) {
  const html = generateIndexHtml(specDir);
  const indexPath = join(specDir, '00-INDEX.html');
  writeFileSync(indexPath, html, 'utf8');
  return indexPath;
}
