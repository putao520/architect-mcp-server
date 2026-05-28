import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { parseHTML } from 'linkedom';
import { extractReqId, parseReqId, parseTestId } from '../utils/schemas.mjs';
import { pathToId } from '../utils/normalize.mjs';
import { parseSpecDir } from '../parse/html-parser.mjs';

export function fixLinks(specDir) {
  const index = parseSpecDir(specDir);
  const { anchorIndex, reqIndex } = buildIndexes(index);
  const allFiles = findAllHtmlFiles(specDir);

  let totalFixed = 0;
  for (const filePath of allFiles) {
    const count = fixFileLinks(filePath, anchorIndex, reqIndex, specDir);
    totalFixed += count;
  }

  return { totalFixed, anchors: Object.keys(anchorIndex).length, reqs: Object.keys(reqIndex).length };
}

export function rewriteXrefs(html, fileName, specIndex) {
  if (!specIndex) return html;

  const { document } = parseHTML(html);
  let modified = false;

  for (const a of document.querySelectorAll('a[data-xref-type]')) {
    const href = a.getAttribute('href') || '';
    const type = a.getAttribute('data-xref-type');
    const text = a.textContent || '';

    let newHref = href.replace(/\.md$/, '.html');

    if (!newHref.includes('#')) {
      const targetId = inferTargetId(text, type, specIndex);
      if (targetId) newHref = `${newHref}#${targetId}`;
    }

    const xrefId = newHref.split('#')[1] || '';
    a.setAttribute('href', newHref);
    a.setAttribute('data-xref-id', xrefId);
    modified = true;
  }

  return modified ? document.toString() : html;
}

function findAllHtmlFiles(specDir) {
  const files = [];
  const entries = readdirSync(specDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith('.html') && entry.name !== '00-INDEX.html') {
      files.push(join(specDir, entry.name));
    } else if (entry.isDirectory()) {
      try {
        const subEntries = readdirSync(join(specDir, entry.name));
        for (const f of subEntries) {
          if (f.endsWith('.html')) files.push(join(specDir, entry.name, f));
        }
      } catch { /* skip */ }
    }
  }
  return files;
}

function buildIndexes(index) {
  const anchorIndex = {};
  const reqIndex = {};
  const dirPath = index.dirPath || '';

  // Build anchor index from idMap (id → {file, ...})
  if (index.idMap) {
    for (const [id, entry] of index.idMap) {
      if (id && entry.file) {
        const lower = id.toLowerCase();
        if (!anchorIndex[lower]) {
          anchorIndex[lower] = `${entry.file}#${id}`;
        }
      }
    }
  }

  // Build req index from reqMap
  if (index.reqMap) {
    for (const [reqId, req] of index.reqMap) {
      if (req.htmlId && req.fileName) {
        reqIndex[reqId] = `${req.fileName}#${req.htmlId}`;
      }
    }
  }

  // Fallback: scan doc elements for data-req
  if (Object.keys(reqIndex).length === 0) {
    for (const doc of index.docs) {
      const relPath = doc.fileName;
      for (const req of (doc.reqs || [])) {
        if (req.htmlId && !reqIndex[req.id]) {
          reqIndex[req.id] = `${relPath}#${req.htmlId}`;
        }
      }
    }
  }

  return { anchorIndex, reqIndex };
}

function fixFileLinks(filePath, anchorIndex, reqIndex, specDir) {
  const raw = readFileSync(filePath, 'utf8');
  const { document } = parseHTML(raw);
  const relDir = dirname(filePath.replace(specDir + '/', ''));
  const prefix = relDir === '.' ? './' : '../';

  let count = 0;

  for (const a of document.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href');
    if (!href || href.startsWith('http://') || href.startsWith('https://')) continue;

    const hashIdx = href.indexOf('#');
    if (hashIdx >= 0) {
      const anchor = href.slice(hashIdx + 1);
      const anchorLower = anchor.toLowerCase();

      if (anchorIndex[anchorLower]) {
        const correctTarget = prefix + anchorIndex[anchorLower];
        if (href !== correctTarget) {
          a.setAttribute('href', correctTarget);
          count++;
          continue;
        }
      }

      const reqId = extractReqId(anchor);
      if (reqId && reqIndex[reqId]) {
        const correctTarget = prefix + reqIndex[reqId];
        if (href !== correctTarget) {
          a.setAttribute('href', correctTarget);
          count++;
        }
      }
    }

    if (a.hasAttribute('data-xref-type')) {
      const type = a.getAttribute('data-xref-type');
      const text = a.textContent || '';
      let newHref = href.replace(/\.md$/, '.html');

      if (!newHref.includes('#')) {
        const targetId = inferTargetId(text, type, { idMap: new Set(Object.keys(anchorIndex)) });
        if (targetId) newHref = `${newHref}#${targetId}`;
      }

      const xrefId = newHref.split('#')[1] || '';
      if (a.getAttribute('href') !== newHref || a.getAttribute('data-xref-id') !== xrefId) {
        a.setAttribute('href', newHref);
        a.setAttribute('data-xref-id', xrefId);
        count++;
      }
    }
  }

  if (count > 0) {
    writeFileSync(filePath, document.toString(), 'utf8');
  }
  return count;
}

function inferTargetId(text, type, specIndex) {
  if (type === 'req') {
    const parsed = parseReqId(extractReqId(text) || text);
    if (parsed) return `req-${parsed.domain.toLowerCase()}-${parsed.number}`;
  }

  if (type === 'test') {
    const parsed = parseTestId(text);
    if (parsed) return `test-${parsed.domain.toLowerCase()}-${parsed.number}`;
  }

  if (type === 'entity') {
    const entityName = text.replace(/^[A-Z]+-/, '').toLowerCase();
    if (specIndex.idMap?.has(`data-${entityName}`)) {
      return `data-${entityName}`;
    }
  }

  if (type === 'api') {
    const apiMatch = text.match(/(GET|POST|PUT|DELETE|PATCH)\s+(\/\S+)/i);
    if (apiMatch) {
      const method = apiMatch[1].toLowerCase();
      return `api-${method}${pathToId(apiMatch[2])}`;
    }
  }

  return '';
}

export function run(args) {
  const dir = args[0] || '.';
  const result = fixLinks(dir);
  console.log(`Fixed ${result.totalFixed} links across ${result.anchors} anchors, ${result.reqs} REQs`);
}
