/**
 * CRUD 引擎 — 路由 + 关联维护 + 写入后验证
 */

import { z } from 'zod';
import { join, resolve } from 'node:path';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { parseHTML } from 'linkedom';
import { parseSpecDir } from '../parse/html-parser.mjs';
import { validateAll } from '../validate/index.mjs';
import { fixLinks } from '../transform/fix-links.mjs';
import { readFileAsDocument, writeDocumentToFile, createXrefElement } from './html-gen.mjs';

const ACTION_SCHEMA = z.enum(['create', 'read', 'update', 'delete', 'list']);
const TYPE_SCHEMA = z.enum(['req', 'entity', 'api', 'test', 'sm', 'algorithm', 'pipeline', 'integration', 'timing', 'nfr', 'xref', 'criterion', 'artifact']);

const CRUD_PARAMS = z.object({
  action: ACTION_SCHEMA,
  type: TYPE_SCHEMA,
  dir: z.string(),
  file: z.string().optional(),
  id: z.string().optional(),
  data: z.any().optional(),
  cascade: z.boolean().default(false),
});

export async function executeCrud(params, handlers) {
  const parsed = CRUD_PARAMS.parse(params);
  const { action, type, dir } = parsed;
  const index = parseSpecDir(dir);

  if (action === 'list') {
    return handlers[type].list(index, params);
  }

  if (action === 'read') {
    return handlers[type].read(index, params);
  }

  // Write operations: create, update, delete
  if (action === 'create' && type === 'xref') {
    const refError = validateXrefTarget(index, params.data || params);
    if (refError) return { ok: false, error: refError };
  }

  if (action === 'create' && type === 'test') {
    const testData = params.data || {};
    if (testData.reqRef && !index.reqMap.has(testData.reqRef)) {
      return { ok: false, error: `Test reqRef "${testData.reqRef}" not found in REQ index` };
    }
  }

  const result = await dispatchWrite(handlers[type], action, index, dir, params);

  if (result.ok && result.affectedFiles?.length > 0) {
    maintainRelations(index, type, action, result, dir);
  }

  if (result.ok && (action === 'create' || action === 'update' || action === 'delete')) {
    const freshIndex = parseSpecDir(dir);
    const validation = validateAll(freshIndex);
    result.validation = { errors: validation.errors.length, warnings: validation.warnings.length };
  }

  return result;
}

async function dispatchWrite(handler, action, index, dir, params) {
  switch (action) {
    case 'create': return handler.create(index, dir, params);
    case 'update': return handler.update(index, dir, params);
    case 'delete': return handler.delete(index, dir, params);
    default: return { ok: false, error: `Unknown action: ${action}` };
  }
}

function maintainRelations(index, type, action, result, dir) {
  const cascadeFiles = [];

  if (action === 'delete' && type === 'req') {
    cascadeFiles.push(...cascadeDeleteReq(index, result, dir));
  }

  if (action === 'delete' && type === 'entity') {
    cascadeFiles.push(...cascadeDeleteEntity(index, result, dir));
  }

  if (action === 'delete' && type === 'sm') {
    cascadeFiles.push(...cascadeDeleteSm(index, result, dir));
  }

  // Generic: remove dangling xrefs pointing to deleted element
  if (action === 'delete') {
    const deletedHtmlId = result.htmlId || result.id;
    const allDocs = index.docs;
    for (const doc of allDocs) {
      const filePath = resolve(dir, `${doc.fileName}.html`);
      if (!existsSync(filePath)) continue;
      const { document } = readFileAsDocument(filePath);
      let modified = false;

      for (const a of document.querySelectorAll(`a[data-xref-id="${deletedHtmlId}"]`)) {
        a.remove();
        modified = true;
      }

      if (modified) writeDocumentToFile(document, filePath);
    }
  }

  result.affectedRelations = cascadeFiles;
}

function cascadeDeleteReq(index, result, dir) {
  const reqId = result.id;
  const htmlId = result.htmlId || result.id;
  const affected = [];

  // 1. Clean test data-req-ref references
  const testEntries = index.testByReqId?.get(reqId) || [];
  for (const { test, doc } of testEntries) {
    const filePath = resolve(dir, `${doc.fileName}.html`);
    if (!existsSync(filePath)) continue;
    const { document } = readFileAsDocument(filePath);

    const testEl = document.querySelector(`[data-test="${test.testId}"]`);
    if (testEl) {
      const currentRef = testEl.getAttribute('data-req-ref') || '';
      const cleaned = currentRef.split(',').map(r => r.trim()).filter(r => r !== reqId).join(',');
      if (cleaned) {
        testEl.setAttribute('data-req-ref', cleaned);
      } else {
        testEl.removeAttribute('data-req-ref');
      }
      writeDocumentToFile(document, filePath);
      affected.push({ type: 'test-reqref-cleaned', file: doc.fileName, testId: test.testId });
    }
  }

  return affected;
}

function cascadeDeleteEntity(index, result, dir) {
  const entityName = result.id;
  const affected = [];

  // Clean API params that reference this entity's fields
  const entityEntry = index.entityByName?.get(entityName);
  if (!entityEntry) return affected;

  const entity = entityEntry.entity;
  const fieldNames = new Set((entity.fields || []).map(f => f.name));

  for (const doc of index.docs) {
    let docModified = false;
    const filePath = resolve(dir, `${doc.fileName}.html`);
    if (!existsSync(filePath)) continue;
    const { document } = readFileAsDocument(filePath);

    for (const paramRow of document.querySelectorAll('table[data-api-params] tr[data-param]')) {
      const paramName = paramRow.getAttribute('data-param');
      if (fieldNames.has(paramName)) {
        paramRow.remove();
        docModified = true;
        affected.push({ type: 'api-param-cleaned', file: doc.fileName, param: paramName });
      }
    }

    if (docModified) writeDocumentToFile(document, filePath);
  }

  return affected;
}

function cascadeDeleteSm(index, result, dir) {
  const smName = result.id;
  const affected = [];

  // Clean xrefs pointing to this SM
  const smHtmlId = result.htmlId || `sm-${smName}`;
  for (const doc of index.docs) {
    const filePath = resolve(dir, `${doc.fileName}.html`);
    if (!existsSync(filePath)) continue;
    const { document } = readFileAsDocument(filePath);
    let modified = false;

    for (const a of document.querySelectorAll(`a[data-xref-type="statemachine"][data-xref-id="${smHtmlId}"]`)) {
      a.remove();
      modified = true;
    }
    for (const a of document.querySelectorAll(`a[data-xref-type="state-machine"][data-xref-id="${smHtmlId}"]`)) {
      a.remove();
      modified = true;
    }

    if (modified) {
      writeDocumentToFile(document, filePath);
      affected.push({ type: 'sm-xref-cleaned', file: doc.fileName, smName });
    }
  }

  return affected;
}

function validateXrefTarget(index, data) {
  const type = data.type;
  const targetId = data.targetId || data.text;

  if (!type) return null;

  switch (type) {
    case 'req': {
      const reqId = targetId;
      if (reqId && !index.reqMap?.has(reqId)) return `Xref target REQ "${reqId}" not found`;
      break;
    }
    case 'entity': {
      if (targetId && !index.entityNameSet?.has(targetId)) return `Xref target entity "${targetId}" not found`;
      break;
    }
    case 'api': {
      const hasPath = index.apiByPath?.has(targetId);
      const hasKey = index.apiByKey?.has(targetId);
      if (targetId && !hasPath && !hasKey) return `Xref target API "${targetId}" not found`;
      break;
    }
    case 'statemachine':
    case 'state-machine': {
      if (targetId && !index.smNameSet?.has(targetId)) return `Xref target SM "${targetId}" not found`;
      break;
    }
    case 'test': {
      const hasTest = index.allTests?.some(t => t.testId === targetId);
      if (targetId && !hasTest) return `Xref target test "${targetId}" not found`;
      break;
    }
    case 'algorithm': {
      if (targetId && !index.algorithmNameSet?.has(targetId)) return `Xref target algorithm "${targetId}" not found`;
      break;
    }
    case 'pipeline': {
      if (targetId && !index.pipelineNameSet?.has(targetId)) return `Xref target pipeline "${targetId}" not found`;
      break;
    }
    case 'integration': {
      if (targetId && !index.integrationNameSet?.has(targetId)) return `Xref target integration "${targetId}" not found`;
      break;
    }
    case 'timing': {
      if (targetId && !index.timingNameSet?.has(targetId)) return `Xref target timing "${targetId}" not found`;
      break;
    }
    case 'nfr': {
      if (targetId && !index.nfrNameSet?.has(targetId)) return `Xref target NFR "${targetId}" not found`;
      break;
    }
  }

  return null;
}

export function resolveTargetFile(index, type, params) {
  if (params.file) {
    const name = params.file.replace(/\.html$/, '');
    const doc = index.fileMap.get(name);
    return doc ? { doc, fileName: name } : null;
  }

  const routing = {
    req: ['02-SYSTEM', '03-PROCESS', '01-BUSINESS'],
    entity: ['04-DATA-MODEL'],
    api: ['02-SYSTEM'],
    test: ['11-TESTING'],
    sm: ['03-PROCESS'],
    algorithm: ['12-ALGORITHMS'],
    pipeline: ['02-SYSTEM'],
    integration: ['02-SYSTEM'],
    timing: ['03-PROCESS'],
    nfr: ['02-SYSTEM'],
    artifact: [],
    xref: [],
    criterion: [],
  };

  for (const candidate of (routing[type] || [])) {
    if (index.fileMap.has(candidate)) {
      return { doc: index.fileMap.get(candidate), fileName: candidate };
    }
  }
  return index.docs.length > 0 ? { doc: index.docs[0], fileName: index.docs[0].fileName } : null;
}

export function findElementById(document, htmlId) {
  return document.getElementById(htmlId) || document.querySelector(`[id="${htmlId}"]`);
}

export function appendToMain(document, element) {
  const main = document.querySelector('[data-spec-content]') || document.querySelector('main') || document.body;
  main.appendChild(element);
}

export function makeResult(action, type, fileName, id, htmlId, extra = {}) {
  return {
    ok: true,
    action,
    type,
    file: fileName,
    id,
    htmlId,
    affectedFiles: [fileName],
    affectedRelations: [],
    ...extra,
  };
}
