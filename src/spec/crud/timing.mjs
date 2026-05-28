/**
 * Timing CRUD handler — SPEC 时序约束的增删改查
 */

import { z } from 'zod';
import { resolve } from 'node:path';
import { resolveTargetFile, findElementById, appendToMain, makeResult } from './engine.mjs';
import { createTimingElement, readFileAsDocument, writeDocumentToFile, inferTimingHtmlId } from './html-gen.mjs';
import { TimingIdSchema } from '../utils/schemas.mjs';

const TimingDataSchema = z.object({
  name: z.string(),
  title: z.string().optional(),
  constraint: z.enum(['deadline', 'latency', 'throughput', 'retry', 'rate', 'concurrency']).optional(),
  target: z.string().optional(),
  unit: z.enum(['ms', 's', 'min', 'req/s', 'rps', 'concurrent']).optional(),
  scope: z.string().optional(),
  description: z.string().optional(),
  retryPolicy: z.object({ maxRetries: z.number(), backoff: z.string(), initialDelay: z.number() }).optional(),
});

function validateData(data) {
  const parsed = TimingDataSchema.safeParse(data);
  if (!parsed.success) return { valid: false, error: parsed.error.message, data: null };
  return { valid: true, error: null, data: parsed.data };
}

export async function create(index, dir, params) {
  const validation = validateData(params.data);
  if (!validation.valid) {
    return { ok: false, error: `Invalid timing data: ${validation.error}` };
  }
  const data = validation.data;

  const target = resolveTargetFile(index, 'timing', params);
  if (!target) {
    return { ok: false, error: 'No target file found for timing element' };
  }

  const filePath = resolve(dir, `${target.fileName}.html`);
  const { document } = readFileAsDocument(filePath);

  const htmlId = inferTimingHtmlId(data.name);
  if (findElementById(document, htmlId)) {
    return { ok: false, error: `Timing element already exists: ${htmlId}` };
  }

  const element = createTimingElement(document, data);
  appendToMain(document, element);
  writeDocumentToFile(document, filePath);

  return makeResult('create', 'timing', target.fileName, data.name, htmlId);
}

export async function read(index, params) {
  const identifier = params.name || params.id;
  if (!identifier) {
    return { ok: false, error: 'Missing name or id for read' };
  }

  const htmlId = params.id || inferTimingHtmlId(params.name);
  const target = resolveTargetFile(index, 'timing', { ...params, id: htmlId });
  if (!target) {
    return { ok: false, error: 'No target file found' };
  }

  const element = findElementById(target.doc, htmlId);
  if (!element) {
    return { ok: false, error: `Timing element not found: ${htmlId}` };
  }

  return {
    ok: true,
    action: 'read',
    type: 'timing',
    htmlId,
    name: element.getAttribute('data-timing') || '',
    file: target.fileName,
  };
}

export async function update(index, dir, params) {
  const validation = validateData(params.data);
  if (!validation.valid) {
    return { ok: false, error: `Invalid timing data: ${validation.error}` };
  }
  const data = validation.data;

  const target = resolveTargetFile(index, 'timing', params);
  if (!target) {
    return { ok: false, error: 'No target file found for timing element' };
  }

  const filePath = resolve(dir, `${target.fileName}.html`);
  const { document } = readFileAsDocument(filePath);

  const htmlId = params.id || inferTimingHtmlId(data.name);
  const existing = findElementById(document, htmlId);
  if (!existing) {
    return { ok: false, error: `Timing element not found: ${htmlId}` };
  }

  existing.remove();
  const element = createTimingElement(document, data);
  appendToMain(document, element);
  writeDocumentToFile(document, filePath);

  const newHtmlId = inferTimingHtmlId(data.name);
  return makeResult('update', 'timing', target.fileName, data.name, newHtmlId);
}

export async function delete_(index, dir, params) {
  const target = resolveTargetFile(index, 'timing', params);
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
    return { ok: false, error: `Timing element not found: ${htmlId}` };
  }

  const timingName = element.getAttribute('data-timing') || htmlId;
  element.remove();
  writeDocumentToFile(document, filePath);

  return makeResult('delete', 'timing', target.fileName, timingName, htmlId);
}

export { delete_ as delete };

export function list(index, params) {
  const results = [];
  const timings = index.allTimings ?? index.docs;
  for (const doc of timings) {
    const elements = doc.document.querySelectorAll('[data-timing]');
    for (const el of elements) {
      results.push({
        id: el.getAttribute('data-timing') || '',
        name: el.getAttribute('data-timing') || '',
        file: doc.fileName,
      });
    }
  }
  return { ok: true, action: 'list', type: 'timing', items: results };
}
