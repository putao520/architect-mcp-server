import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { stripHtmlExt } from '../utils/normalize.mjs';

export function validateLinks(index) {
  const errors = [];
  const warnings = [];

  for (const doc of index.docs) {
    for (const xref of doc.xrefs) {
      const result = checkLink(xref, doc, index);
      if (result.broken) {
        errors.push({ file: doc.fileName, message: `Broken link: ${xref.href} (from #${xref.sourceId})` });
      } else if (result.warning) {
        warnings.push({ file: doc.fileName, message: result.warning });
      }
    }
  }

  return { errors, warnings };
}

function checkLink(xref, sourceDoc, index) {
  const href = xref.href;
  if (!href) return { broken: true };
  if (href.startsWith('http://') || href.startsWith('https://')) return {};

  let targetFile, fragment;
  const hashIdx = href.indexOf('#');

  if (hashIdx >= 0) {
    fragment = href.slice(hashIdx + 1);
    targetFile = href.slice(0, hashIdx) || `${sourceDoc.fileName}.html`;
  } else {
    targetFile = href;
    fragment = null;
  }

  const targetName = stripHtmlExt(targetFile);

  if (targetFile.startsWith('./') || targetFile.startsWith('../') || !targetFile.includes('/')) {
    const targetDoc = index.fileMap.get(targetName);
    if (!targetDoc) {
      const fullPath = resolve(index.dirPath, targetFile);
      if (existsSync(fullPath)) return {};
      return { broken: true };
    }
    if (fragment) {
      if (!index.idMap.has(fragment)) return { broken: true };
      const target = index.idMap.get(fragment);
      if (target.file !== targetName) {
        return { warning: `ID ${fragment} exists in ${target.file}, not ${targetName}` };
      }
    }
  } else {
    if (!existsSync(resolve(index.dirPath, targetFile))) return { broken: true };
  }

  return {};
}

export async function run(args) {
  const dir = args[0] || '.';
  const { parseSpecDir } = await import('../parse/html-parser.mjs');
  const index = parseSpecDir(dir);
  const total = index.docs.reduce((s, d) => s + d.xrefs.length, 0);
  const result = validateLinks(index);

  console.log(`Links check: ${total} links in ${index.docs.length} files`);
  for (const e of result.errors) console.log(`  BROKEN  ${e.file}: ${e.message}`);
  for (const w of result.warnings) console.log(`  WARNING ${w.file}: ${w.message}`);
  if (result.errors.length === 0) console.log('  All links valid.');
  process.exit(result.errors.length > 0 ? 1 : 0);
}