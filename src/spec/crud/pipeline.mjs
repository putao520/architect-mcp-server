/**
 * Pipeline CRUD handler — SPEC 流水线的增删改查
 */

import { z } from 'zod';
import { resolve } from 'node:path';
import { resolveTargetFile, findElementById, appendToMain, makeResult } from './engine.mjs';
import { createPipelineElement, readFileAsDocument, writeDocumentToFile, inferPipelineHtmlId } from './html-gen.mjs';
import { PipelineIdSchema } from '../utils/schemas.mjs';

const PipelineDataSchema = z.object({
  name: z.string(),
  title: z.string().optional(),
  type: z.enum(['etl', 'cicd', 'dataflow', 'stream']).optional(),
  stages: z.array(z.object({
    name: z.string(),
    input: z.string().optional(),
    output: z.string().optional(),
    transform: z.string().optional(),
  })).optional(),
  description: z.string().optional(),
});

function validateData(data) {
  const parsed = PipelineDataSchema.safeParse(data);
  if (!parsed.success) return { valid: false, error: parsed.error.message, data: null };
  return { valid: true, error: null, data: parsed.data };
}

function findByName(index, name) {
  const htmlId = inferPipelineHtmlId(name);
  for (const doc of index.docs) {
    const el = findElementById(doc.document, htmlId);
    if (el) return { doc, fileName: doc.fileName, element: el, htmlId };
  }
  return null;
}

export async function create(index, dir, params) {
  const validation = validateData(params.data);
  if (!validation.valid) {
    return { ok: false, error: `Invalid pipeline data: ${validation.error}` };
  }
  const data = validation.data;

  const target = resolveTargetFile(index, 'pipeline', params);
  if (!target) {
    return { ok: false, error: 'No target file found for pipeline element' };
  }

  const filePath = resolve(dir, `${target.fileName}.html`);
  const { document } = readFileAsDocument(filePath);

  const htmlId = inferPipelineHtmlId(data.name);
  if (findElementById(document, htmlId)) {
    return { ok: false, error: `Pipeline element already exists: ${htmlId}` };
  }

  const element = createPipelineElement(document, data);
  appendToMain(document, element);
  writeDocumentToFile(document, filePath);

  return makeResult('create', 'pipeline', target.fileName, data.name, htmlId);
}

export async function read(index, params) {
  const htmlId = params.id || (params.name ? inferPipelineHtmlId(params.name) : null);
  if (!htmlId) {
    return { ok: false, error: 'Missing id or name for read' };
  }

  const found = findByName(index, htmlId);
  if (!found) {
    return { ok: false, error: `Pipeline element not found: ${htmlId}` };
  }

  return {
    ok: true,
    action: 'read',
    type: 'pipeline',
    htmlId,
    name: found.element.getAttribute('data-pipeline') || '',
    file: found.fileName,
  };
}

export async function update(index, dir, params) {
  const validation = validateData(params.data);
  if (!validation.valid) {
    return { ok: false, error: `Invalid pipeline data: ${validation.error}` };
  }
  const data = validation.data;

  const target = resolveTargetFile(index, 'pipeline', params);
  if (!target) {
    return { ok: false, error: 'No target file found for pipeline element' };
  }

  const filePath = resolve(dir, `${target.fileName}.html`);
  const { document } = readFileAsDocument(filePath);

  const htmlId = params.id || inferPipelineHtmlId(data.name);
  const existing = findElementById(document, htmlId);
  if (!existing) {
    return { ok: false, error: `Pipeline element not found: ${htmlId}` };
  }

  existing.remove();
  const element = createPipelineElement(document, data);
  appendToMain(document, element);
  writeDocumentToFile(document, filePath);

  const newHtmlId = inferPipelineHtmlId(data.name);
  return makeResult('update', 'pipeline', target.fileName, data.name, newHtmlId);
}

export async function delete_(index, dir, params) {
  const target = resolveTargetFile(index, 'pipeline', params);
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
    return { ok: false, error: `Pipeline element not found: ${htmlId}` };
  }

  const pipelineName = element.getAttribute('data-pipeline') || htmlId;
  element.remove();
  writeDocumentToFile(document, filePath);

  return makeResult('delete', 'pipeline', target.fileName, pipelineName, htmlId);
}

export { delete_ as delete };

export function list(index, params) {
  const results = [];
  const docs = index.allPipelines
    ? index.allPipelines()
    : index.docs;
  for (const doc of docs) {
    const elements = (doc.document || doc).querySelectorAll('[data-pipeline]');
    for (const el of elements) {
      results.push({
        id: el.getAttribute('data-pipeline') || '',
        name: el.getAttribute('data-pipeline') || '',
        file: doc.fileName,
      });
    }
  }
  return { ok: true, action: 'list', type: 'pipeline', items: results };
}
