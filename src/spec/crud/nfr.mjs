/**
 * NFR CRUD handler — SPEC 非功能需求的增删改查
 */

import { z } from 'zod';
import { resolve } from 'node:path';
import { resolveTargetFile, findElementById, appendToMain, makeResult } from './engine.mjs';
import { createNfrElement, readFileAsDocument, writeDocumentToFile, inferNfrHtmlId } from './html-gen.mjs';
import { NfrIdSchema } from '../utils/schemas.mjs';

const MetricSchema = z.object({
  name: z.string(),
  operator: z.string(),
  threshold: z.string(),
  unit: z.string().optional(),
});

const NfrDataSchema = z.object({
  name: z.string(),
  title: z.string().optional(),
  category: z.enum(['performance', 'availability', 'compliance', 'accessibility', 'i18n', 'scalability', 'reliability', 'observability']).optional(),
  metrics: z.array(MetricSchema).optional(),
  description: z.string().optional(),
  regulation: z.enum(['GDPR', 'HIPAA', 'PCI-DSS', 'SOC2', 'WCAG', 'ISO27001']).optional(),
});

function validateData(data) {
  const parsed = NfrDataSchema.safeParse(data);
  if (!parsed.success) return { valid: false, error: parsed.error.message, data: null };
  return { valid: true, error: null, data: parsed.data };
}

export async function create(index, dir, params) {
  const validation = validateData(params.data);
  if (!validation.valid) {
    return { ok: false, error: `Invalid NFR data: ${validation.error}` };
  }
  const data = validation.data;

  const target = resolveTargetFile(index, 'nfr', params);
  if (!target) {
    return { ok: false, error: 'No target file found for NFR element' };
  }

  const filePath = resolve(dir, `${target.fileName}.html`);
  const { document } = readFileAsDocument(filePath);

  const htmlId = inferNfrHtmlId(data.name);
  if (findElementById(document, htmlId)) {
    return { ok: false, error: `NFR element already exists: ${htmlId}` };
  }

  const element = createNfrElement(document, data);
  appendToMain(document, element);
  writeDocumentToFile(document, filePath);

  return makeResult('create', 'nfr', target.fileName, data.name, htmlId);
}

export async function read(index, params) {
  const target = resolveTargetFile(index, 'nfr', params);
  if (!target) {
    return { ok: false, error: 'No target file found' };
  }

  const htmlId = params.id || (params.name ? inferNfrHtmlId(params.name) : null);
  if (!htmlId) {
    return { ok: false, error: 'Missing id or name for read' };
  }

  const element = findElementById(target.doc, htmlId);
  if (!element) {
    return { ok: false, error: `NFR element not found: ${htmlId}` };
  }

  return {
    ok: true,
    action: 'read',
    type: 'nfr',
    htmlId,
    name: element.getAttribute('data-nfr') || '',
    category: element.getAttribute('data-nfr-category') || '',
    file: target.fileName,
  };
}

export async function update(index, dir, params) {
  const validation = validateData(params.data);
  if (!validation.valid) {
    return { ok: false, error: `Invalid NFR data: ${validation.error}` };
  }
  const data = validation.data;

  const target = resolveTargetFile(index, 'nfr', params);
  if (!target) {
    return { ok: false, error: 'No target file found for NFR element' };
  }

  const filePath = resolve(dir, `${target.fileName}.html`);
  const { document } = readFileAsDocument(filePath);

  const htmlId = params.id || inferNfrHtmlId(data.name);
  const existing = findElementById(document, htmlId);
  if (!existing) {
    return { ok: false, error: `NFR element not found: ${htmlId}` };
  }

  existing.remove();
  const element = createNfrElement(document, data);
  appendToMain(document, element);
  writeDocumentToFile(document, filePath);

  const newHtmlId = inferNfrHtmlId(data.name);
  return makeResult('update', 'nfr', target.fileName, data.name, newHtmlId);
}

export async function delete_(index, dir, params) {
  const target = resolveTargetFile(index, 'nfr', params);
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
    return { ok: false, error: `NFR element not found: ${htmlId}` };
  }

  const nfrName = element.getAttribute('data-nfr') || htmlId;
  element.remove();
  writeDocumentToFile(document, filePath);

  return makeResult('delete', 'nfr', target.fileName, nfrName, htmlId);
}

export { delete_ as delete };

export function list(index, params) {
  const results = [];
  for (const doc of index.docs) {
    const elements = doc.document.querySelectorAll('[data-nfr]');
    for (const el of elements) {
      results.push({
        id: el.getAttribute('data-nfr') || '',
        name: el.getAttribute('data-nfr') || '',
        category: el.getAttribute('data-nfr-category') || '',
        file: doc.fileName,
      });
    }
  }
  return { ok: true, action: 'list', type: 'nfr', items: results };
}
