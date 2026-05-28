/**
 * Xref CRUD — 双向交叉引用维护
 * 创建/删除时自动维护反向链接，保持引用网络一致性。
 */

import { resolve } from 'node:path';
import { z } from 'zod';
import { makeResult, findElementById } from './engine.mjs';
import { createXrefElement, readFileAsDocument, writeDocumentToFile } from './html-gen.mjs';

const XREF_TYPE_SCHEMA = z.enum([
  'req', 'entity', 'api', 'test', 'statemachine', 'section',
]);

const XREF_DATA = z.object({
  sourceFile: z.string(),
  sourceId: z.string(),
  targetFile: z.string(),
  targetId: z.string(),
  type: XREF_TYPE_SCHEMA,
  text: z.string(),
});

function resolveFilePath(dir, fileName) {
  const base = fileName.replace(/\.html$/, '');
  return resolve(dir, `${base}.html`);
}

function sourceHeadingText(element) {
  const h = element.querySelector('h1, h2, h3, h4, h5, h6');
  return h ? h.textContent.trim() : (element.getAttribute('id') || '');
}

function findXrefAnchor(document, xrefId, xrefType) {
  return document.querySelector(
    `a[data-xref-id="${xrefId}"][data-xref-type="${xrefType}"]`
  );
}

/**
 * 创建正向 + 反向交叉引用
 */
export function create(index, dir, params) {
  const data = XREF_DATA.parse(params.data || params);
  const { sourceFile, sourceId, targetFile, targetId, type, text } = data;

  // --- 正向链接：source → target ---
  const sourcePath = resolveFilePath(dir, sourceFile);
  const source = readFileAsDocument(sourcePath);
  const sourceEl = findElementById(source.document, sourceId);
  if (!sourceEl) {
    return { ok: false, error: `Source element not found: ${sourceId} in ${sourceFile}` };
  }

  const forwardAnchor = createXrefElement(source.document, targetFile, targetId, type, text);
  sourceEl.appendChild(forwardAnchor);
  writeDocumentToFile(source.document, sourcePath);

  // --- 反向链接：target → source ---
  const targetPath = resolveFilePath(dir, targetFile);
  const target = readFileAsDocument(targetPath);
  const targetEl = findElementById(target.document, targetId);
  if (!targetEl) {
    return { ok: false, error: `Target element not found: ${targetId} in ${targetFile}` };
  }

  const sourceDisplay = sourceHeadingText(sourceEl);
  const reverseAnchor = createXrefElement(
    target.document, sourceFile, sourceId, 'xref-backref', sourceDisplay
  );
  targetEl.appendChild(reverseAnchor);
  writeDocumentToFile(target.document, targetPath);

  return makeResult('create', 'xref', sourceFile, `${sourceId}->${targetId}`, sourceId, {
    affectedFiles: [sourceFile, targetFile],
    forward: { sourceFile, sourceId, targetFile, targetId, type, text },
    reverse: { sourceFile: targetFile, sourceId: targetId, targetFile: sourceFile, targetId: sourceId, type: 'xref-backref', text: sourceDisplay },
  });
}

/**
 * 读取单条交叉引用
 */
export function read(index, params) {
  const { sourceId, targetId } = params.data || params;
  const xrefs = collectAllXrefs(index);
  const match = xrefs.find(x => x.sourceId === sourceId && x.targetId === targetId);
  if (!match) {
    return { ok: false, error: `Xref not found: ${sourceId} -> ${targetId}` };
  }
  return { ok: true, ...match };
}

/**
 * 更新交叉引用文本（删除旧链接重建）
 */
export function update(index, dir, params) {
  const data = XREF_DATA.parse(params.data || params);
  const { sourceFile, sourceId, targetFile, targetId, type, text } = data;

  const sourcePath = resolveFilePath(dir, sourceFile);
  const source = readFileAsDocument(sourcePath);

  const anchor = findXrefAnchor(source.document, targetId, type);
  if (!anchor) {
    return { ok: false, error: `Forward xref not found: type=${type}, id=${targetId} in ${sourceFile}` };
  }
  anchor.textContent = text;
  writeDocumentToFile(source.document, sourcePath);

  return makeResult('update', 'xref', sourceFile, `${sourceId}->${targetId}`, sourceId, {
    affectedFiles: [sourceFile],
  });
}

/**
 * 双向删除交叉引用
 */
export function deleteXref(index, dir, params) {
  const { sourceFile, targetId, type, targetFile, sourceId } = params.data || params;

  const affectedFiles = [];

  // 删除正向链接
  if (sourceFile) {
    const sourcePath = resolveFilePath(dir, sourceFile);
    const source = readFileAsDocument(sourcePath);
    const forward = findXrefAnchor(source.document, targetId, type);
    if (forward) {
      forward.remove();
      writeDocumentToFile(source.document, sourcePath);
      affectedFiles.push(sourceFile);
    }
  }

  // 删除反向链接
  if (targetFile) {
    const targetPath = resolveFilePath(dir, targetFile);
    const target = readFileAsDocument(targetPath);
    const reverse = findXrefAnchor(target.document, sourceId, 'xref-backref');
    if (reverse) {
      reverse.remove();
      writeDocumentToFile(target.document, targetPath);
      if (!affectedFiles.includes(targetFile)) {
        affectedFiles.push(targetFile);
      }
    }
  }

  return makeResult('delete', 'xref', sourceFile || '', `${sourceId}->${targetId}`, sourceId || '', {
    affectedFiles,
  });
}

/** Alias for engine dispatch (delete is a reserved word in strict mode) */
export { deleteXref as delete };

/**
 * 列出所有交叉引用（可按 sourceFile / type 过滤）
 */
export function list(index, params) {
  const filter = params.data || params;
  return { ok: true, xrefs: collectAllXrefs(index, filter) };
}

function collectAllXrefs(index, filter = {}) {
  const results = [];

  for (const doc of index.docs) {
    for (const xr of doc.xrefs) {
      if (xr.type === 'xref-backref') continue;

      const entry = {
        sourceFile: doc.fileName,
        sourceId: xr.sourceId,
        targetFile: extractTargetFile(xr.href),
        targetId: xr.xrefId || extractTargetAnchor(xr.href),
        type: xr.type,
        text: xr.text,
      };

      if (filter.sourceFile && entry.sourceFile !== filter.sourceFile) continue;
      if (filter.type && entry.type !== filter.type) continue;
      if (filter.sourceId && entry.sourceId !== filter.sourceId) continue;

      results.push(entry);
    }
  }

  return results;
}

function extractTargetFile(href) {
  if (!href) return '';
  const hashIdx = href.indexOf('#');
  const filePart = hashIdx >= 0 ? href.slice(0, hashIdx) : href;
  return filePart.replace(/\.html$/, '');
}

function extractTargetAnchor(href) {
  if (!href) return '';
  const hashIdx = href.indexOf('#');
  return hashIdx >= 0 ? href.slice(hashIdx + 1) : '';
}
