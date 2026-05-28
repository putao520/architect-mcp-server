/**
 * Test CRUD handler — SPEC 测试用例的增删改查
 */

import { z } from 'zod';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { resolveTargetFile, findElementById, appendToMain, makeResult } from './engine.mjs';
import {
  createTestElement,
  createXrefElement,
  readFileAsDocument,
  writeDocumentToFile,
  inferTestHtmlId,
  inferReqHtmlId,
} from './html-gen.mjs';
import { TestIdSchema } from '../utils/schemas.mjs';

const TestDataSchema = z.object({
  id: TestIdSchema,
  reqRef: z.string(),
  title: z.string(),
  categories: z.array(z.string()).optional(),
  description: z.string().optional(),
});

function validateData(data) {
  return TestDataSchema.safeParse(data);
}

export async function create(index, dir, params) {
  const parsed = validateData(params.data);
  if (!parsed.success) {
    return { ok: false, error: `Invalid test data: ${parsed.error.message}` };
  }
  const data = parsed.data;

  const target = resolveTargetFile(index, 'test', params);
  if (!target) {
    return { ok: false, error: 'No target file found for test element' };
  }

  const filePath = resolve(dir, `${target.fileName}.html`);
  const { document } = readFileAsDocument(filePath);

  const htmlId = inferTestHtmlId(data.id);
  if (findElementById(document, htmlId)) {
    return { ok: false, error: `Test element already exists: ${htmlId}` };
  }

  const element = createTestElement(document, data);

  if (data.reqRef) {
    const reqHtmlId = inferReqHtmlId(data.reqRef);
    const xref = createXrefElement(document, '', reqHtmlId, 'req', data.reqRef);
    element.appendChild(xref);
  }

  appendToMain(document, element);
  writeDocumentToFile(document, filePath);

  // 创建反向 xref：在 REQ 所在文件中创建指向 test 的 backref
  const affectedFiles = [target.fileName];
  if (data.reqRef) {
    const reqHtmlId = inferReqHtmlId(data.reqRef);
    const reqEntry = index.reqMap?.get(data.reqRef);
    if (reqEntry) {
      const reqDoc = index.docs.find(d => d.reqs.some(r => r.id === data.reqRef));
      if (reqDoc && reqDoc.fileName !== target.fileName) {
        const reqFilePath = resolve(dir, `${reqDoc.fileName}.html`);
        if (existsSync(reqFilePath)) {
          const { document: reqDoc2 } = readFileAsDocument(reqFilePath);
          const reqEl = findElementById(reqDoc2, reqHtmlId);
          if (reqEl) {
            const backref = createXrefElement(reqDoc2, target.fileName, htmlId, 'test', data.id);
            reqEl.appendChild(backref);
            writeDocumentToFile(reqDoc2, reqFilePath);
            affectedFiles.push(reqDoc.fileName);
          }
        }
      }
    }
  }

  return makeResult('create', 'test', target.fileName, data.id, htmlId, {
    affectedFiles,
  });
}

export async function read(index, params) {
  const target = resolveTargetFile(index, 'test', params);
  if (!target) {
    return { ok: false, error: 'No target file found' };
  }

  const htmlId = params.id;
  if (!htmlId) {
    return { ok: false, error: 'Missing id for read' };
  }

  const element = findElementById(target.doc, htmlId);
  if (!element) {
    return { ok: false, error: `Test element not found: ${htmlId}` };
  }

  return {
    ok: true,
    action: 'read',
    type: 'test',
    htmlId,
    id: element.getAttribute('data-test') || '',
    reqRef: element.getAttribute('data-req-ref') || '',
    title: element.querySelector('h3')?.textContent || '',
    file: target.fileName,
  };
}

export async function update(index, dir, params) {
  const parsed = validateData(params.data);
  if (!parsed.success) {
    return { ok: false, error: `Invalid test data: ${parsed.error.message}` };
  }
  const data = parsed.data;

  const target = resolveTargetFile(index, 'test', params);
  if (!target) {
    return { ok: false, error: 'No target file found for test element' };
  }

  const filePath = resolve(dir, `${target.fileName}.html`);
  const { document } = readFileAsDocument(filePath);

  const htmlId = params.id || inferTestHtmlId(data.id);
  const existing = findElementById(document, htmlId);
  if (!existing) {
    return { ok: false, error: `Test element not found: ${htmlId}` };
  }

  existing.remove();
  const element = createTestElement(document, data);

  if (data.reqRef) {
    const reqHtmlId = inferReqHtmlId(data.reqRef);
    const xref = createXrefElement(document, '', reqHtmlId, 'req', data.reqRef);
    element.appendChild(xref);
  }

  appendToMain(document, element);
  writeDocumentToFile(document, filePath);

  const newHtmlId = inferTestHtmlId(data.id);
  return makeResult('update', 'test', target.fileName, data.id, newHtmlId);
}

export async function delete_(index, dir, params) {
  const target = resolveTargetFile(index, 'test', params);
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
    return { ok: false, error: `Test element not found: ${htmlId}` };
  }

  const testId = element.getAttribute('data-test') || htmlId;
  element.remove();
  writeDocumentToFile(document, filePath);

  return makeResult('delete', 'test', target.fileName, testId, htmlId);
}

export { delete_ as delete };

export function list(index, params) {
  const results = [];
  for (const doc of index.docs) {
    const elements = doc.document.querySelectorAll('[data-test]');
    for (const el of elements) {
      results.push({
        id: el.getAttribute('data-test') || '',
        reqRef: el.getAttribute('data-req-ref') || '',
        title: el.querySelector('h3')?.textContent || '',
        categories: (el.getAttribute('data-test-categories') || '').split(',').filter(Boolean),
        file: doc.fileName,
      });
    }
  }
  return { ok: true, action: 'list', type: 'test', items: results };
}
