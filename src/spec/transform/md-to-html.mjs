import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { assignIds } from './id-assigner.mjs';
import { rewriteXrefs } from './fix-links.mjs';
import { buildJsonLd } from './jsonld-builder.mjs';
import { writeIndexHtml } from './index-builder.mjs';
import { slugify, pathToId as pathSlug, extractSectionNumber } from '../utils/normalize.mjs';
import { slugifySection as utilsSlugifySection } from '../utils/normalize.mjs';
import { extractReqId, inferDomain } from '../utils/schemas.mjs';
import { specTypeToJsonSchema, isKnownSpecType } from '../schema/type-system.mjs';
import { inferCategory, inferTitle, inferDependencies } from '../utils/constants.mjs';
import { renderInline, parseMdDocument } from '../utils/md.mjs';
import { escapeHtml } from '../utils/html.mjs';

const HEADING_RE = /^(#{1,6})\s+(.+)/;
const TABLE_ROW_RE = /^\|(.+)\|$/;
const TABLE_SEP_RE = /^\|[-:\s|]+\|$/;
const LINK_RE = /\[([^\]]*)\]\(([^)]+)\)/g;
const ENTITY_TABLE_RE = /(?:表|实体|Entity)/;
const API_TABLE_RE = /(?:API|端点|接口|Endpoint)/;
const INDEX_STRATEGY_RE = /(?:索引策略|Index.*Strategy)/;

const SECTION_NUM_RE = /§(\d+)/;

// KEEP_IN_MAIN: keyed by fileName, values are § section numbers to retain in main file.
// Sections NOT listed here are split into individual sub-files (one per ## section).
// Only files that need splitting are listed.
const KEEP_IN_MAIN = {
  '02-SYSTEM':  ['1', '5', '10', '12'],
  '03-PROCESS': ['1'],
  '04-DATA-MODEL': ['1', '3'],
  '06-SECURITY': ['1', '2'],
};

// Sub-file directory and naming prefix for files that split.
const SPLIT_CONFIG = {
  '02-SYSTEM':  { dir: 'system', prefix: '02' },
  '03-PROCESS': { dir: 'process', prefix: '03' },
  '04-DATA-MODEL': { dir: 'data', prefix: '04' },
  '06-SECURITY': { dir: 'security', prefix: '06' },
};

export function convertMdToHtml(mdPath, specIndex = null) {
  const raw = readFileSync(mdPath, 'utf8');
  const fileName = basename(mdPath).replace(/\.md(\.bak)?$/, '');

  const parsed = parseMdDocument(raw);
  const result = splitBySection(fileName, parsed);

  if (result.subFiles.length > 0) {
    return generateMultiFileOutput(fileName, result, specIndex);
  }

  const mainHtml = generateMainFileHtml(fileName, result.mainSections, [], specIndex);
  return { main: mainHtml, subFiles: [] };
}

function splitBySection(fileName, parsed) {
  const config = SPLIT_CONFIG[fileName];
  if (!config) {
    return { mainSections: parsed.sections, subFiles: [] };
  }

  const keepNums = new Set(KEEP_IN_MAIN[fileName] || []);
  const mainSections = [];
  const subFiles = [];
  let subIndex = 0;
  const assignedToSub = new Set();

  // Pass 1: determine which ## sections go to sub-files
  const h2Decisions = [];
  for (let i = 0; i < parsed.sections.length; i++) {
    const section = parsed.sections[i];
    if (section.level !== 2) continue;

    const numMatch = section.text.match(SECTION_NUM_RE);
    const sectionNum = numMatch ? numMatch[1] : null;
    const keep = sectionNum && keepNums.has(sectionNum);
    h2Decisions.push({ index: i, section, sectionNum, keep });
  }

  // Pass 2: build sub-files for non-kept sections
  for (const decision of h2Decisions) {
    if (decision.keep) continue;

    const group = collectSubSectionGroup(parsed.sections, decision.section);
    const slug = slugifySectionLocal(decision.section.text, decision.sectionNum);
    subIndex++;
    const subFileName = `${config.dir}/${config.prefix}.${String(subIndex).padStart(2, '0')}-${slug}`;

    let type = 'section';
    if (API_TABLE_RE.test(decision.section.text) || decision.section.content.some(l => /(?:POST|GET|PUT|DELETE|PATCH)\s+\/api/.test(l))) {
      type = 'api';
    } else if (ENTITY_TABLE_RE.test(decision.section.text) || decision.section.tables.some(t => t.rows.length > 1)) {
      type = 'entity';
    } else if (/安全|security|限流|加密|审计/i.test(decision.section.text)) {
      type = 'security';
    }

    subFiles.push({
      domain: decision.section.text.replace(/^§?\d+(\.\d+)?\s*/, '').trim(),
      sections: group,
      fileName: subFileName,
      type,
    });

    for (const s of group) assignedToSub.add(s);
  }

  // Pass 3: everything not assigned to sub-files goes to main
  for (const section of parsed.sections) {
    if (!assignedToSub.has(section)) {
      mainSections.push(section);
    }
  }

  return { mainSections, subFiles };
}

function collectSubSectionGroup(allSections, startSection) {
  const group = [startSection];
  const startIdx = allSections.indexOf(startSection);
  for (let i = startIdx + 1; i < allSections.length; i++) {
    if (allSections[i].level <= startSection.level) break;
    group.push(allSections[i]);
  }
  return group;
}

function slugifySectionLocal(text, sectionNum) {
  const result = utilsSlugifySection(text, sectionNum);
  return result === `section-${sectionNum}` && !text.trim() ? 'untitled' : result;
}

function generateMultiFileOutput(fileName, result, specIndex) {
  const mainHtml = generateMainFileHtml(fileName, result.mainSections, result.subFiles, specIndex);
  const subFileOutputs = [];
  for (const sub of result.subFiles) {
    const subHtml = generateSubFileHtml(fileName, sub, specIndex);
    subFileOutputs.push({ path: sub.fileName + '.html', html: subHtml });
  }
  return { main: mainHtml, subFiles: subFileOutputs };
}

function generateMainFileHtml(fileName, mainSections, subFiles, specIndex) {
  const title = mainSections[0]?.text || inferTitle(fileName);
  const category = inferCategory(fileName);
  const deps = inferDependencies(fileName);

  let body = '';
  for (const section of mainSections) {
    body += renderSectionHtml(section, fileName, specIndex);
  }

  if (subFiles && subFiles.length > 0) {
    body += `    <section id="s-index" data-section="index">\n      <h2>子文件索引</h2>\n      <table data-index-table="subfiles">\n        <tr><th>内容域</th><th>类型</th><th>文件</th></tr>\n`;
    for (const sub of subFiles) {
      body += `        <tr><td>${esc(sub.domain)}</td><td>${esc(sub.type)}</td><td><a href="./${sub.fileName}.html" data-xref-type="spec-subfile">${sub.fileName}</a></td></tr>\n`;
    }
    body += `      </table>\n    </section>\n`;
  }

  const childrenJson = (subFiles || []).map(s => `"${s.fileName}"`).join(',');

  return `<!DOCTYPE html>
<html lang="zh-CN" data-spec-root>
<head>
  <meta charset="utf-8">
  <meta name="spec-file" content="${fileName}">
  <meta name="spec-category" content="${category}">
${deps.map(d => `  <link rel="spec:depends" href="${d}.html">`).join('\n')}
  <script type="application/ld+json">
  { "@context":"https://spec.gsc.local/v1", "@type":"SpecDocument", "id":"${fileName}", "dependencies":${JSON.stringify(deps)}, "children":[${childrenJson}] }
  </script>
</head>
<body>
  <header data-spec-header>
    <h1>${esc(title)}</h1>
    <nav data-spec-breadcrumb>
      <a href="./00-INDEX.html">SPEC</a> &gt; <span>${fileName}</span>
    </nav>
  </header>
  <main data-spec-content>
${body}  </main>
  <footer data-spec-footer>
    <address data-spec-ssot>SSOT 定义者：${fileName}.html</address>
  </footer>
</body>
</html>`;
}

function generateSubFileHtml(parentName, sub, specIndex) {
  const category = inferCategory(parentName);
  let body = '';
  for (const section of sub.sections) {
    body += renderSectionHtml(section, sub.fileName, specIndex, sub.type);
  }

  const typeLabel = sub.type === 'api' ? 'API' : sub.type === 'entity' ? '实体' : sub.type === 'security' ? '安全' : '';

  return `<!DOCTYPE html>
<html lang="zh-CN" data-spec-root>
<head>
  <meta charset="utf-8">
  <meta name="spec-file" content="${parentName}">
  <meta name="spec-subfile" content="${sub.fileName}">
  <meta name="spec-category" content="${category}">
  <link rel="spec:depends" href="../${parentName}.html">
  <script type="application/ld+json">
  { "@context":"https://spec.gsc.local/v1", "@type":"SpecSubfile", "id":"${sub.fileName}", "parent":"${parentName}" }
  </script>
</head>
<body>
  <header data-spec-header>
    <h1>${esc(sub.domain)} ${typeLabel}</h1>
    <nav data-spec-breadcrumb>
      <a href="../00-INDEX.html">SPEC</a> &gt;
      <a href="../${parentName}.html">${parentName}</a> &gt;
      <span>${esc(sub.domain)}</span>
    </nav>
  </header>
  <main data-spec-content>
${body}  </main>
  <footer data-spec-footer>
    <address data-spec-ssot>SSOT 定义者：${parentName}.html / ${sub.fileName}.html</address>
  </footer>
</body>
</html>`;
}

function renderSectionHtml(section, fileName, specIndex, subType) {
  const id = assignSectionId(section, fileName);
  const tag = `h${Math.min(section.level + 1, 6)}`;
  const isReq = extractReqId(section.text);

  let html = `    <section id="${id}"${isReq ? ` data-req="${isReq}" data-req-status="unknown" data-req-domain="${inferDomain(isReq)}"` : ''} data-section="${extractSectionNumber(section.text)}">\n`;
  html += `      <${tag}>${esc(section.text)}</${tag}>\n`;

  const isEntityTable = ENTITY_TABLE_RE.test(section.text) || subType === 'entity' || /^\$?§?\d+[\d.]*\s+\w+\s*—/.test(section.text);
  const isApiTable = API_TABLE_RE.test(section.text) || subType === 'api' || section.tables.some(t => t.rows[0]?.some(c => /端点|路径|Endpoint/.test(c)));
  const isIndexStrategy = INDEX_STRATEGY_RE.test(section.text);

  for (const line of section.content) {
    if (HEADING_RE.test(line)) continue;
    if (TABLE_ROW_RE.test(line) || TABLE_SEP_RE.test(line)) continue;
    let processed = processInlineMarkup(line, fileName, specIndex);
    if (processed.trim()) html += `      ${processed}\n`;
  }

  if (isEntityTable && section.tables.length > 0) {
    html += renderEntityTable(section);
  } else if (isApiTable && section.tables.length > 0) {
    html += renderApiTable(section);
  } else if (isIndexStrategy && section.tables.length > 0) {
    html += renderIndexStrategyTable(section);
  } else {
    for (const table of section.tables) html += renderTable(table);
  }

  for (const codeBlock of section.codeBlocks || []) {
    if (codeBlock.lang === 'mermaid' && codeBlock.content.includes('stateDiagram')) {
      const jsonld = buildJsonLd(codeBlock.content, 'stateDiagram');
      if (jsonld) html += `    <script type="application/ld+json">\n${JSON.stringify(jsonld, null, 2)}\n    </script>\n`;
    }
  }

  html += `    </section>\n`;
  return html;
}

function renderEntityTable(section) {
  const entityName = extractEntityName(section);
  let html = `      <table data-entity-table="${esc(entityName)}">\n        <tr><th>字段</th><th>类型</th><th>必填</th><th>约束</th><th>说明</th></tr>\n`;
  for (const table of section.tables) {
    if (table.rows.length < 2) continue;
    const header = table.rows[0];
    const colMap = mapColumns(header, ['字段', '类型', '必填', '约束', '说明']);
    for (let i = 1; i < table.rows.length; i++) {
      const row = table.rows[i];
      const fieldName = col(row, colMap, '字段', 0);
      const fieldType = col(row, colMap, '类型', 1);
      const rawRequired = col(row, colMap, '必填', 2);
      const rawConstraints = col(row, colMap, '约束', -1);
      const fieldDesc = col(row, colMap, '说明', 3);

      const { required, constraints } = parseFieldConstraints(rawRequired, rawConstraints);
      const typeWarning = validateFieldType(fieldType);
      html += `        <tr data-field="${esc(fieldName)}" data-type="${esc(fieldType)}" data-required="${required}"${constraints ? ` data-constraints="${esc(constraints)}"` : ''}${typeWarning ? ` data-type-warning="${esc(typeWarning)}"` : ''}>\n`;
      html += `          <td>${esc(fieldName)}</td><td>${esc(fieldType)}</td><td>${esc(rawRequired || '—')}</td><td>${esc(constraints || rawConstraints || '—')}</td><td>${esc(fieldDesc)}</td>\n`;
      html += `        </tr>\n`;
    }
  }
  html += `      </table>\n`;

  // Extract entity relations from content (FK references like `table.field`)
  const relations = extractEntityRelations(section);
  if (relations.length > 0) {
    html += `      <script type="application/ld+json">\n${JSON.stringify({ '@type': 'EntityRelations', entity: entityName, relations }, null, 2)}\n      </script>\n`;
  }

  return html;
}

function extractEntityName(section) {
  const match = section.text.match(/§?\d+[\d.]*\s+(\w+)/);
  if (match) return match[1];
  return section.text.replace(/(?:表|实体|Entity).*$/, '').trim();
}

function validateFieldType(fieldType) {
  if (!fieldType) return null;
  if (!isKnownSpecType(fieldType)) return `unknown-type:${fieldType}`;
  return null;
}

function parseFieldConstraints(rawRequired, rawConstraints) {
  const combined = [rawRequired, rawConstraints].filter(Boolean).join(', ');
  const tokens = combined.split(/[,，\s]+/).filter(Boolean);
  const isRequired = tokens.some(t => /^(PK|UK|NOT.?NULL|必填)$/i.test(t));
  const constraintTags = tokens.filter(t => /^(PK|FK|UK|UQ|IDX|UNIQUE|AUTO_INCREMENT|NOT.?NULL|DEFAULT|CHECK)$/i.test(t));
  return {
    required: isRequired ? 'true' : 'false',
    constraints: constraintTags.length > 0 ? constraintTags.join(',') : null,
  };
}

function extractEntityRelations(section) {
  const relations = [];
  const fkRe = /([a-z_]+)\.([a-z_]+)|FK[：:]\s*(\w+)\.(\w+)|关联[到至]?\s*`?(\w+)`?\s*(?:表|实体)?/gi;
  for (const line of section.content) {
    let match;
    while ((match = fkRe.exec(line)) !== null) {
      const target = match[1] || match[3] || match[5];
      const fk = match[2] || match[4] || 'id';
      if (target && !relations.some(r => r.target === target)) {
        relations.push({ type: 'many-to-one', target, fk });
      }
    }
  }
  return relations;
}

function renderApiTable(section) {
  let html = `      <table data-api-params>\n        <tr><th>端点</th><th>方法</th><th>说明</th><th>角色</th></tr>\n`;
  for (const table of section.tables) {
    if (table.rows.length < 2) continue;
    const header = table.rows[0];
    const colMap = mapColumns(header, ['端点', '方法', '说明', '角色', '最低角色']);
    for (let i = 1; i < table.rows.length; i++) {
      const row = table.rows[i];
      const method = col(row, colMap, '方法', 1) || 'GET';
      const path = col(row, colMap, '端点', 0);
      const desc = col(row, colMap, '说明', 2);
      const role = col(row, colMap, '角色', 3) || col(row, colMap, '最低角色', 3);
      const apiId = `api-${method.toLowerCase()}-${pathSlug(path)}`;
      html += `        <tr id="${esc(apiId)}" data-api="${esc(method)} ${esc(path)}" data-api-method="${esc(method)}" data-api-role="${esc(role)}">\n`;
      html += `          <td>${esc(path)}</td><td>${esc(method)}</td><td>${esc(desc)}</td><td>${esc(role)}</td>\n`;
      html += `        </tr>\n`;
    }
  }
  html += `      </table>\n`;

  // Extract API response contract from code blocks
  for (const codeBlock of section.codeBlocks || []) {
    if (codeBlock.lang === 'json') {
      try {
        const parsed = JSON.parse(codeBlock.content);
        if (parsed && (parsed.code || parsed.data || parsed.error || parsed.token)) {
          html += `      <script type="application/ld+json">\n${JSON.stringify({ '@type': 'ApiResponse', source: 'example', body: parsed }, null, 2)}\n      </script>\n`;
        }
      } catch { /* not valid JSON, skip */ }
    }
  }

  return html;
}

function mapColumns(header, names) {
  const map = {};
  for (const name of names) {
    const idx = header.findIndex(h => h.trim().includes(name));
    if (idx !== -1) map[name] = idx;
  }
  return map;
}

function col(row, colMap, name, fallbackIdx) {
  if (colMap[name] !== undefined && row[colMap[name]]) return row[colMap[name]]?.trim() || '';
  if (fallbackIdx >= 0 && row[fallbackIdx]) return row[fallbackIdx]?.trim() || '';
  return '';
}

function renderIndexStrategyTable(section) {
  let html = `      <section data-index-strategy>\n        <table data-index-table>\n          <tr><th>索引名</th><th>字段</th><th>类型</th><th>唯一</th><th>条件</th></tr>\n`;
  for (const table of section.tables) {
    if (table.rows.length < 2) continue;
    for (let i = 1; i < table.rows.length; i++) {
      const row = table.rows[i];
      html += `          <tr>${row.map(c => `<td>${esc(c?.trim() || '')}</td>`).join('')}</tr>\n`;
    }
  }
  html += `        </table>\n      </section>\n`;
  return html;
}

function processInlineMarkup(line, fileName, specIndex) {
  let result = line;
  result = result.replace(LINK_RE, (match, text, href) => {
    const htmlHref = href.replace(/\.md$/, '.html');
    const xrefType = inferXrefType(text, href);
    return `<a href="${htmlHref}" data-xref-type="${xrefType}">${esc(text)}</a>`;
  });
  result = renderInline(result);
  if (result.trim().startsWith('- ') || result.trim().startsWith('* ')) {
    return result.replace(/^\s*[-*]\s+/, '<li>') + '</li>';
  }
  if (result.trim() && !result.trim().startsWith('<')) return '<p>' + result + '</p>';
  return result;
}

function renderTable(table) {
  if (table.rows.length < 2) return '';
  const isReqIndex = table.rows[0].some(c => /\bREQ\b/.test(c));
  let html = isReqIndex ? '      <table data-req-index>\n' : '      <table>\n';
  for (let i = 0; i < table.rows.length; i++) {
    const tag = i === 0 ? 'th' : 'td';
    const reqMatchText = i > 0 && isReqIndex ? table.rows[i].find(c => extractReqId(c)) : null;
    if (reqMatchText) {
      const reqId = extractReqId(reqMatchText);
      html += `        <tr data-req="${reqId}" data-req-status="unknown" data-req-domain="${inferDomain(reqId)}">\n`;
    } else {
      html += '        <tr>\n';
    }
    for (const cell of table.rows[i]) html += `          <${tag}>${esc(cell)}</${tag}>\n`;
    html += '        </tr>\n';
  }
  html += '      </table>\n';
  return html;
}

function assignSectionId(section, fileName) {
  const num = extractSectionNumber(section.text);
  if (num) return `s${num}`;
  return `s-${slugify(section.text)}`;
}

function inferXrefType(text, href) {
  if (href.includes('REQ-') || text.match(/REQ-/)) return 'req';
  if (href.includes('TEST-') || text.match(/TEST-/)) return 'test';
  if (href.includes('04-DATA-MODEL') || text.match(/^[A-Z][a-z]+$/)) return 'entity';
  if (href.includes('02-SYSTEM') || text.match(/API|endpoint/i)) return 'api';
  return 'section';
}

const esc = escapeHtml;

export async function executeFullMigration(mdPath, specDir, options = {}) {
  const fileName = basename(mdPath).replace(/\.md(\.bak)?$/, '');
  const result = convertMdToHtml(mdPath, options.specIndex || null);
  const htmlPath = mdPath.replace(/\.md(\.bak)?$/, '.html');
  writeFileSync(htmlPath, result.main, 'utf8');

  if (result.subFiles && result.subFiles.length > 0) {
    for (const sub of result.subFiles) {
      const subDir = dirname(sub.path);
      const fullSubDir = join(specDir, subDir);
      mkdirSync(fullSubDir, { recursive: true });
      writeFileSync(join(specDir, sub.path), sub.html, 'utf8');
    }
  }

  if (options.generateIndex !== false) {
    writeIndexHtml(specDir);
  }

  return { main: htmlPath, subFiles: (result.subFiles || []).map(s => s.path) };
}
