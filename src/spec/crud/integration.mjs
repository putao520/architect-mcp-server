/**
 * Integration CRUD handler — SPEC 集成元素的增删改查
 */

import { z } from 'zod';
import { resolve } from 'node:path';
import { resolveTargetFile, findElementById, appendToMain, makeResult } from './engine.mjs';
import { createIntegrationElement, readFileAsDocument, writeDocumentToFile, inferIntegrationHtmlId } from './html-gen.mjs';
import { IntegrationIdSchema } from '../utils/schemas.mjs';

const IntegrationDataSchema = z.object({
  name: z.string(),
  title: z.string().optional(),
  protocol: z.enum(['http', 'https', 'grpc', 'ws', 'mqtt', 'amqp', 'tcp', 'udp']).optional(),
  auth: z.enum(['oauth2', 'apikey', 'basic', 'mtls', 'jwt', 'none']).optional(),
  endpoints: z.array(z.string()).optional(),
  rateLimit: z.object({ rps: z.number(), burst: z.number() }).optional(),
  fallback: z.string().optional(),
  description: z.string().optional(),
});

function validateData(data) {
  const parsed = IntegrationDataSchema.safeParse(data);
  if (!parsed.success) return { valid: false, error: parsed.error.message, data: null };
  return { valid: true, error: null, data: parsed.data };
}

export async function create(index, dir, params) {
  const validation = validateData(params.data);
  if (!validation.valid) {
    return { ok: false, error: `Invalid integration data: ${validation.error}` };
  }
  const data = validation.data;

  const target = resolveTargetFile(index, 'integration', { ...params, file: params.file || undefined });
  if (!target) {
    return { ok: false, error: 'No target file found for integration element' };
  }

  const filePath = resolve(dir, `${target.fileName}.html`);
  const { document } = readFileAsDocument(filePath);

  const htmlId = inferIntegrationHtmlId(data.name);
  if (findElementById(document, htmlId)) {
    return { ok: false, error: `Integration element already exists: ${htmlId}` };
  }

  const element = createIntegrationElement(document, data);
  appendToMain(document, element);
  writeDocumentToFile(document, filePath);

  return makeResult('create', 'integration', target.fileName, data.name, htmlId);
}

export async function read(index, params) {
  const target = resolveTargetFile(index, 'integration', params);
  if (!target) {
    return { ok: false, error: 'No target file found' };
  }

  const htmlId = params.id || (params.name ? inferIntegrationHtmlId(params.name) : null);
  if (!htmlId) {
    return { ok: false, error: 'Missing id or name for read' };
  }

  const element = findElementById(target.doc, htmlId);
  if (!element) {
    return { ok: false, error: `Integration element not found: ${htmlId}` };
  }

  return {
    ok: true,
    action: 'read',
    type: 'integration',
    htmlId,
    name: element.getAttribute('data-integration') || '',
    file: target.fileName,
  };
}

export async function update(index, dir, params) {
  const validation = validateData(params.data);
  if (!validation.valid) {
    return { ok: false, error: `Invalid integration data: ${validation.error}` };
  }
  const data = validation.data;

  const target = resolveTargetFile(index, 'integration', params);
  if (!target) {
    return { ok: false, error: 'No target file found for integration element' };
  }

  const filePath = resolve(dir, `${target.fileName}.html`);
  const { document } = readFileAsDocument(filePath);

  const htmlId = params.id || inferIntegrationHtmlId(data.name);
  const existing = findElementById(document, htmlId);
  if (!existing) {
    return { ok: false, error: `Integration element not found: ${htmlId}` };
  }

  existing.remove();
  const element = createIntegrationElement(document, data);
  appendToMain(document, element);
  writeDocumentToFile(document, filePath);

  const newHtmlId = inferIntegrationHtmlId(data.name);
  return makeResult('update', 'integration', target.fileName, data.name, newHtmlId);
}

export async function delete_(index, dir, params) {
  const target = resolveTargetFile(index, 'integration', params);
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
    return { ok: false, error: `Integration element not found: ${htmlId}` };
  }

  const integrationName = element.getAttribute('data-integration') || htmlId;
  element.remove();
  writeDocumentToFile(document, filePath);

  return makeResult('delete', 'integration', target.fileName, integrationName, htmlId);
}

export { delete_ as delete };

export function list(index, params) {
  const results = [];
  const integrations = index.allIntegrations ||
    index.docs.flatMap(doc => {
      const elements = doc.document.querySelectorAll('[data-integration]');
      return [...elements].map(el => ({
        id: el.getAttribute('data-integration') || '',
        name: el.getAttribute('data-integration') || '',
        file: doc.fileName,
      }));
    });

  for (const item of integrations) {
    results.push(item);
  }
  return { ok: true, action: 'list', type: 'integration', items: results };
}
