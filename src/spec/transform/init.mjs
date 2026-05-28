import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { writeIndexHtml } from './index-builder.mjs';
import { FILE_CATEGORIES as CATEGORIES, FILE_TITLES as TITLES, FILE_DEPENDENCIES } from '../utils/constants.mjs';

const SPEC_FILES = {
  'web-admin': [
    '01-BUSINESS', '02-SYSTEM', '03-PROCESS', '04-DATA-MODEL',
    '05-DEPLOYMENT', '06-SECURITY', '07-OPERATIONS',
    '08-PAGES', '09-ADMIN-CRUD', '10-REQUIREMENTS',
    '11-TESTING', '13-UX-DESIGN',
  ],
  'api-service': [
    '01-BUSINESS', '02-SYSTEM', '03-PROCESS', '04-DATA-MODEL',
    '05-DEPLOYMENT', '06-SECURITY', '07-OPERATIONS',
    '10-REQUIREMENTS', '11-TESTING',
  ],
};

const SUB_DIRS = {
  '02-SYSTEM': 'system',
  '04-DATA-MODEL': 'data',
  '06-SECURITY': 'security',
  '03-PROCESS': 'process',
  '08-PAGES': 'pages',
  '10-REQUIREMENTS': 'requirements',
};

export function run(args) {
  const dir = args[0] || '.';
  const type = args[1] || 'web-admin';
  initSpec(dir, type);
}

export function initSpec(dir, type = 'web-admin') {
  const specDir = resolve(dir, 'SPEC');
  mkdirSync(specDir, { recursive: true });

  const files = SPEC_FILES[type] || SPEC_FILES['web-admin'];

  for (const name of files) {
    const filePath = join(specDir, `${name}.html`);
    if (existsSync(filePath)) {
      console.log(`  SKIP ${name}.html (exists)`);
      continue;
    }
    writeFileSync(filePath, generateTemplate(name, type), 'utf8');
    console.log(`  CREATE ${name}.html`);

    if (SUB_DIRS[name]) {
      const subDir = join(specDir, SUB_DIRS[name]);
      mkdirSync(subDir, { recursive: true });
      console.log(`  MKDIR ${SUB_DIRS[name]}/`);
    }
  }

  const indexPath = join(specDir, '00-INDEX.html');
  try {
    writeIndexHtml(specDir);
    console.log(`  CREATE 00-INDEX.html`);
  } catch {
    if (!existsSync(indexPath)) {
      writeFileSync(indexPath, generateFallbackIndex(files), 'utf8');
      console.log(`  CREATE 00-INDEX.html (fallback)`);
    }
  }

  console.log(`\nInitialized ${files.length} SPEC files in ${specDir}`);
}

function generateTemplate(name, type) {
  const category = CATEGORIES[name] || 'unknown';
  const title = TITLES[name] || name;
  const deps = FILE_DEPENDENCIES[name] || [];
  const subDir = SUB_DIRS[name];

  return `<!DOCTYPE html>
<html lang="zh-CN" data-spec-root>
<head>
  <meta charset="utf-8">
  <meta name="spec-file" content="${name}">
  <meta name="spec-category" content="${category}">
${deps.map(d => `  <link rel="spec:depends" href="${d}.html">`).join('\n')}
  <script type="application/ld+json">
  {
    "@context": "https://spec.gsc.local/v1",
    "@type": "SpecDocument",
    "id": "${name}",
    "dependencies": ${JSON.stringify(deps)}
  }
  </script>
</head>
<body>
  <header data-spec-header>
    <h1>${title}</h1>
    <nav data-spec-breadcrumb>
      <a href="./00-INDEX.html">SPEC</a> &gt; <span>${name}</span>
    </nav>
  </header>

  <main data-spec-content>
    <section id="s1" data-section="1">
      <h2>§1 概览</h2>
      <p><!-- TODO: 填写概览 --></p>
    </section>
${subDir ? `    <section id="s-index" data-section="index">\n      <h2>子文件索引</h2>\n      <p>详见 <a href="./${subDir}/" data-xref-type="spec-subfile">${subDir}/</a> 目录</p>\n    </section>` : ''}
  </main>

  <footer data-spec-footer>
    <address data-spec-ssot>
      SSOT 定义者：${name}.html
    </address>
  </footer>
</body>
</html>
`;
}

function generateFallbackIndex(files) {
  return `<!DOCTYPE html>
<html lang="zh-CN" data-spec-root>
<head>
  <meta charset="utf-8">
  <meta name="spec-file" content="00-INDEX">
  <meta name="spec-category" content="index">
</head>
<body>
  <header data-spec-header>
    <h1>SPEC 导航索引</h1>
  </header>

  <main data-spec-content>
    <nav data-spec-nav>
      <ul>
${files.map(f => `        <li><a href="./${f}.html">${f} — ${TITLES[f] || f}</a></li>`).join('\n')}
      </ul>
    </nav>
  </main>

  <footer data-spec-footer>
    <address data-spec-ssot>自动生成</address>
  </footer>
</body>
</html>
`;
}