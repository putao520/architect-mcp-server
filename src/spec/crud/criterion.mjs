/**
 * Criterion CRUD — REQ 验收标准的增删查
 * 通过 data-criterion 属性定位标准条目。
 */

import { resolve } from 'node:path';
import { z } from 'zod';
import { makeResult, findElementById, resolveTargetFile } from './engine.mjs';
import { readFileAsDocument, writeDocumentToFile } from './html-gen.mjs';

const CRITERION_DATA = z.object({
  reqId: z.string(),
  text: z.string(),
  criterionId: z.string().optional(),
});

/**
 * 为指定 REQ 添加验收标准
 */
export function create(index, dir, params) {
  const data = CRITERION_DATA.parse(params.data || params);
  const { reqId, text, criterionId } = data;

  const target = resolveTargetFile(index, 'req', { id: reqId });
  if (!target) {
    return { ok: false, error: `REQ file not found for: ${reqId}` };
  }

  const filePath = resolve(dir, `${target.fileName}.html`);
  const { document } = readFileAsDocument(filePath);

  const reqEl = document.querySelector(`[data-req="${reqId}"]`);
  if (!reqEl) {
    return { ok: false, error: `REQ element not found: ${reqId} in ${target.fileName}` };
  }

  const div = document.createElement('div');
  div.setAttribute('data-criterion', text);
  if (criterionId) div.setAttribute('data-criterion-id', criterionId);
  div.textContent = text;
  reqEl.appendChild(div);

  writeDocumentToFile(document, filePath);

  return makeResult('create', 'criterion', target.fileName, reqId, reqEl.getAttribute('id'), {
    affectedFiles: [target.fileName],
    criterion: { reqId, text, criterionId },
  });
}

/**
 * 读取指定 REQ 的所有验收标准
 */
export function read(index, params) {
  const { reqId } = params.data || params;
  if (!reqId) return { ok: false, error: 'reqId is required' };

  const criteria = findCriteriaForReq(index, reqId);
  return { ok: true, reqId, criteria };
}

/**
 * 更新验收标准文本
 */
export function update(index, dir, params) {
  const data = CRITERION_DATA.parse(params.data || params);
  const { reqId, text, criterionId } = data;
  const oldText = params.oldText || data.oldText;
  if (!oldText) return { ok: false, error: 'oldText is required for update' };

  const target = resolveTargetFile(index, 'req', { id: reqId });
  if (!target) return { ok: false, error: `REQ file not found for: ${reqId}` };

  const filePath = resolve(dir, `${target.fileName}.html`);
  const { document } = readFileAsDocument(filePath);

  const el = document.querySelector(`[data-req="${reqId}"] [data-criterion="${oldText}"]`);
  if (!el) return { ok: false, error: `Criterion not found: "${oldText}" in ${reqId}` };

  el.setAttribute('data-criterion', text);
  el.textContent = text;
  writeDocumentToFile(document, filePath);

  return makeResult('update', 'criterion', target.fileName, reqId, '', {
    affectedFiles: [target.fileName],
  });
}

/**
 * 删除指定验收标准
 */
export function delete_(index, dir, params) {
  const data = CRITERION_DATA.parse(params.data || params);
  const { reqId, text } = data;

  const target = resolveTargetFile(index, 'req', { id: reqId });
  if (!target) return { ok: false, error: `REQ file not found for: ${reqId}` };

  const filePath = resolve(dir, `${target.fileName}.html`);
  const { document } = readFileAsDocument(filePath);

  const el = document.querySelector(`[data-req="${reqId}"] [data-criterion="${text}"]`);
  if (!el) return { ok: false, error: `Criterion not found: "${text}" in ${reqId}` };

  el.remove();
  writeDocumentToFile(document, filePath);

  return makeResult('delete', 'criterion', target.fileName, reqId, '', {
    affectedFiles: [target.fileName],
  });
}

/** Alias for engine dispatch */
export { delete_ as delete };

/**
 * 列出指定 REQ 的所有验收标准
 */
export function list(index, params) {
  const { reqId } = params.data || params;

  if (reqId) {
    return { ok: true, reqId, criteria: findCriteriaForReq(index, reqId) };
  }

  const all = [];
  for (const req of index.allReqs) {
    const criteria = req.criteria || [];
    if (criteria.length > 0) {
      all.push({ reqId: req.id, criteria });
    }
  }
  return { ok: true, criteria: all };
}

function findCriteriaForReq(index, reqId) {
  const req = index.reqMap?.get(reqId);
  if (!req) return [];
  return (req.criteria || []).map(c => ({
    id: c.id || '',
    text: c.text,
    reqId,
  }));
}
