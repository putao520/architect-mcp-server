/**
 * API CRUD handler — SPEC API 端点的增删改查
 */

import { z } from 'zod';
import { resolve, join } from 'node:path';
import { existsSync } from 'node:fs';
import { resolveTargetFile, findElementById, appendToMain, makeResult } from './engine.mjs';
import { createApiElement, createApiGroupElement, readFileAsDocument, writeDocumentToFile, inferApiHtmlId } from './html-gen.mjs';

const ApiDataSchema = z.object({
  method: z.enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']),
  path: z.string().regex(/^\//),
  title: z.string().optional(),
  role: z.string().optional(),
  group: z.string().optional(),
  params: z.array(z.object({
    name: z.string(),
    type: z.string(),
    required: z.boolean(),
    description: z.string().optional(),
  })).optional(),
  response: z.any().optional(),
});

function validateData(data) {
  return ApiDataSchema.safeParse(data);
}

export async function create(index, dir, params) {
  const parsed = validateData(params.data);
  if (!parsed.success) {
    return { ok: false, error: `Invalid API data: ${parsed.error.message}` };
  }
  const data = parsed.data;
  const target = resolveTargetFile(index, 'api', params);
  if (!target) {
    return { ok: false, error: 'No target file found for API element' };
  }

  const filePath = resolve(dir, `${target.fileName}.html`);
  const { document } = readFileAsDocument(filePath);

  const htmlId = inferApiHtmlId(data.method, data.path);
  if (findElementById(document, htmlId)) {
    return { ok: false, error: `API element already exists: ${htmlId}` };
  }

  const element = createApiElement(document, data);

  if (data.group) {
    let groupEl = document.querySelector(`[data-api-group="${data.group}"]`);
    if (!groupEl) {
      groupEl = createApiGroupElement(document, data.group);
      appendToMain(document, groupEl);
    }
    groupEl.appendChild(element);
  } else {
    appendToMain(document, element);
  }

  writeDocumentToFile(document, filePath);

  return makeResult('create', 'api', target.fileName, `${data.method} ${data.path}`, htmlId);
}

export async function read(index, params) {
  const target = resolveTargetFile(index, 'api', params);
  if (!target) {
    return { ok: false, error: 'No target file found' };
  }

  const htmlId = params.id;
  if (!htmlId) {
    return { ok: false, error: 'Missing id for read' };
  }

  const element = findElementById(target.doc, htmlId);
  if (!element) {
    return { ok: false, error: `API element not found: ${htmlId}` };
  }

  return {
    ok: true,
    action: 'read',
    type: 'api',
    htmlId,
    method: element.getAttribute('data-api')?.split(' ')[0] || '',
    path: element.getAttribute('data-api')?.split(' ').slice(1).join(' ') || '',
    title: element.querySelector('h4')?.textContent || '',
    file: target.fileName,
  };
}

export async function update(index, dir, params) {
  const parsed = validateData(params.data);
  if (!parsed.success) {
    return { ok: false, error: `Invalid API data: ${parsed.error.message}` };
  }
  const data = parsed.data;

  const target = resolveTargetFile(index, 'api', params);
  if (!target) {
    return { ok: false, error: 'No target file found for API element' };
  }

  const filePath = resolve(dir, `${target.fileName}.html`);
  const { document } = readFileAsDocument(filePath);

  const htmlId = params.id || inferApiHtmlId(data.method, data.path);
  const existing = findElementById(document, htmlId);
  if (!existing) {
    return { ok: false, error: `API element not found: ${htmlId}` };
  }

  existing.remove();
  const element = createApiElement(document, data);

  if (data.group) {
    let groupEl = document.querySelector(`[data-api-group="${data.group}"]`);
    if (!groupEl) {
      groupEl = createApiGroupElement(document, data.group);
      appendToMain(document, groupEl);
    }
    groupEl.appendChild(element);
  } else {
    appendToMain(document, element);
  }

  writeDocumentToFile(document, filePath);

  const newHtmlId = inferApiHtmlId(data.method, data.path);
  return makeResult('update', 'api', target.fileName, `${data.method} ${data.path}`, newHtmlId);
}

export async function delete_(index, dir, params) {
  const target = resolveTargetFile(index, 'api', params);
  if (!target) {
    return { ok: false, error: 'No target file found' };
  }

  const htmlId = params.id;
  if (!htmlId) {
    return { ok: false, error: 'Missing id for delete' };
  }

  const filePath = resolve(dir, `${target.fileName}.html`);
  const { document } = readFileAsDocument(filePath);

  const element = findElementById(document, htmlId);
  if (!element) {
    return { ok: false, error: `API element not found: ${htmlId}` };
  }

  const apiId = element.getAttribute('data-api') || htmlId;
  element.remove();
  writeDocumentToFile(document, filePath);

  return makeResult('delete', 'api', target.fileName, apiId, htmlId);
}

export { delete_ as delete };

export function list(index, params) {
  const results = [];
  for (const doc of index.docs) {
    const elements = doc.document.querySelectorAll('[data-api]');
    for (const el of elements) {
      const apiAttr = el.getAttribute('data-api') || '';
      const spaceIdx = apiAttr.indexOf(' ');
      results.push({
        id: apiAttr,
        method: spaceIdx > 0 ? apiAttr.slice(0, spaceIdx) : '',
        path: spaceIdx > 0 ? apiAttr.slice(spaceIdx + 1) : '',
        title: el.querySelector('h4')?.textContent?.replace(/^[A-Z]+\s\/\S*\s*—\s*/, '') || '',
        group: el.closest('[data-api-group]')?.getAttribute('data-api-group') || '',
        file: doc.fileName,
      });
    }
  }
  return { ok: true, action: 'list', type: 'api', items: results };
}
