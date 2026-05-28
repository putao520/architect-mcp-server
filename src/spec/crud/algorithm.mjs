/**
 * Algorithm CRUD handler — SPEC 算法的增删改查
 */

import { z } from 'zod';
import { resolve } from 'node:path';
import { resolveTargetFile, findElementById, appendToMain, makeResult } from './engine.mjs';
import { createAlgorithmElement, readFileAsDocument, writeDocumentToFile, inferAlgorithmHtmlId } from './html-gen.mjs';
import { AlgorithmIdSchema } from '../utils/schemas.mjs';

const AlgorithmDataSchema = z.object({
  name: z.string(),
  title: z.string().optional(),
  type: z.enum(['sorting', 'search', 'graph', 'ml', 'crypto', 'encoding', 'optimization', 'numeric', 'other']).optional(),
  complexity: z.string().optional(),
  space: z.string().optional(),
  description: z.string().optional(),
  pseudocode: z.string().optional(),
  constraints: z.array(z.string()).optional(),
});

function validateData(data) {
  const parsed = AlgorithmDataSchema.safeParse(data);
  if (!parsed.success) return { valid: false, error: parsed.error.message, data: null };

  if (parsed.data.name) {
    const idResult = AlgorithmIdSchema.safeParse(parsed.data.name);
    if (!idResult.success) {
      return { valid: false, error: `Invalid algorithm name format: ${idResult.error.message}`, data: null };
    }
  }

  return { valid: true, error: null, data: parsed.data };
}

export async function create(index, dir, params) {
  const validation = validateData(params.data);
  if (!validation.valid) {
    return { ok: false, error: `Invalid algorithm data: ${validation.error}` };
  }
  const data = validation.data;

  const target = resolveTargetFile(index, 'algorithm', params);
  if (!target) {
    return { ok: false, error: 'No target file found for algorithm element' };
  }

  const filePath = resolve(dir, `${target.fileName}.html`);
  const { document } = readFileAsDocument(filePath);

  const htmlId = inferAlgorithmHtmlId(data.name);
  if (findElementById(document, htmlId)) {
    return { ok: false, error: `Algorithm element already exists: ${htmlId}` };
  }

  const element = createAlgorithmElement(document, data);
  appendToMain(document, element);
  writeDocumentToFile(document, filePath);

  return makeResult('create', 'algorithm', target.fileName, data.name, htmlId);
}

export async function read(index, params) {
  const lookup = params.name || params.id;
  if (!lookup) {
    return { ok: false, error: 'Missing name or id for read' };
  }

  const htmlId = params.id || inferAlgorithmHtmlId(params.name);

  for (const doc of index.docs) {
    const element = findElementById(doc.document, htmlId);
    if (element) {
      return {
        ok: true,
        action: 'read',
        type: 'algorithm',
        htmlId,
        name: element.getAttribute('data-algorithm') || '',
        file: doc.fileName,
      };
    }
  }

  return { ok: false, error: `Algorithm element not found: ${htmlId}` };
}

export async function update(index, dir, params) {
  const validation = validateData(params.data);
  if (!validation.valid) {
    return { ok: false, error: `Invalid algorithm data: ${validation.error}` };
  }
  const data = validation.data;

  const target = resolveTargetFile(index, 'algorithm', params);
  if (!target) {
    return { ok: false, error: 'No target file found for algorithm element' };
  }

  const filePath = resolve(dir, `${target.fileName}.html`);
  const { document } = readFileAsDocument(filePath);

  const htmlId = params.id || inferAlgorithmHtmlId(data.name);
  const existing = findElementById(document, htmlId);
  if (!existing) {
    return { ok: false, error: `Algorithm element not found: ${htmlId}` };
  }

  existing.remove();
  const element = createAlgorithmElement(document, data);
  appendToMain(document, element);
  writeDocumentToFile(document, filePath);

  const newHtmlId = inferAlgorithmHtmlId(data.name);
  return makeResult('update', 'algorithm', target.fileName, data.name, newHtmlId);
}

export async function delete_(index, dir, params) {
  const target = resolveTargetFile(index, 'algorithm', params);
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
    return { ok: false, error: `Algorithm element not found: ${htmlId}` };
  }

  const algName = element.getAttribute('data-algorithm') || htmlId;
  element.remove();
  writeDocumentToFile(document, filePath);

  return makeResult('delete', 'algorithm', target.fileName, algName, htmlId);
}

export { delete_ as delete };

export function list(index, params) {
  const results = index.allAlgorithms
    ? index.allAlgorithms.map(a => ({ id: a.name, name: a.name, file: a.file }))
    : (() => {
        const items = [];
        for (const doc of index.docs) {
          const elements = doc.document.querySelectorAll('[data-algorithm]');
          for (const el of elements) {
            items.push({
              id: el.getAttribute('data-algorithm') || '',
              name: el.getAttribute('data-algorithm') || '',
              file: doc.fileName,
            });
          }
        }
        return items;
      })();

  return { ok: true, action: 'list', type: 'algorithm', items: results };
}
