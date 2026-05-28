/**
 * StateMachine CRUD handler — SPEC 状态机的增删改查
 */

import { z } from 'zod';
import { resolve } from 'node:path';
import { resolveTargetFile, findElementById, appendToMain, makeResult } from './engine.mjs';
import { createStateMachineElement, readFileAsDocument, writeDocumentToFile, inferSmHtmlId } from './html-gen.mjs';

const TransitionSchema = z.object({
  from: z.string(),
  to: z.string(),
  on: z.string().optional(),
});

const SmDataSchema = z.object({
  name: z.string(),
  states: z.array(z.string()),
  initialState: z.string().optional(),
  transitions: z.array(TransitionSchema),
});

function validateData(data) {
  const parsed = SmDataSchema.safeParse(data);
  if (!parsed.success) return { valid: false, error: parsed.error.message, data: null };

  const { states, transitions, initialState } = parsed.data;
  const stateSet = new Set(states);

  for (const t of transitions) {
    if (!stateSet.has(t.from)) {
      return { valid: false, error: `Transition "from" state not in states: "${t.from}"`, data: null };
    }
    if (!stateSet.has(t.to)) {
      return { valid: false, error: `Transition "to" state not in states: "${t.to}"`, data: null };
    }
  }

  if (initialState !== undefined && !stateSet.has(initialState)) {
    return { valid: false, error: `initialState "${initialState}" not in states`, data: null };
  }

  return { valid: true, error: null, data: parsed.data };
}

export async function create(index, dir, params) {
  const validation = validateData(params.data);
  if (!validation.valid) {
    return { ok: false, error: `Invalid state machine data: ${validation.error}` };
  }
  const data = validation.data;

  const target = resolveTargetFile(index, 'sm', params);
  if (!target) {
    return { ok: false, error: 'No target file found for state machine element' };
  }

  const filePath = resolve(dir, `${target.fileName}.html`);
  const { document } = readFileAsDocument(filePath);

  const htmlId = inferSmHtmlId(data.name);
  if (findElementById(document, htmlId)) {
    return { ok: false, error: `State machine element already exists: ${htmlId}` };
  }

  const element = createStateMachineElement(document, data);
  appendToMain(document, element);
  writeDocumentToFile(document, filePath);

  return makeResult('create', 'sm', target.fileName, data.name, htmlId);
}

export async function read(index, params) {
  const target = resolveTargetFile(index, 'sm', params);
  if (!target) {
    return { ok: false, error: 'No target file found' };
  }

  const htmlId = params.id;
  if (!htmlId) {
    return { ok: false, error: 'Missing id for read' };
  }

  const element = findElementById(target.doc, htmlId);
  if (!element) {
    return { ok: false, error: `State machine element not found: ${htmlId}` };
  }

  return {
    ok: true,
    action: 'read',
    type: 'sm',
    htmlId,
    name: element.getAttribute('data-state-machine') || '',
    file: target.fileName,
  };
}

export async function update(index, dir, params) {
  const validation = validateData(params.data);
  if (!validation.valid) {
    return { ok: false, error: `Invalid state machine data: ${validation.error}` };
  }
  const data = validation.data;

  const target = resolveTargetFile(index, 'sm', params);
  if (!target) {
    return { ok: false, error: 'No target file found for state machine element' };
  }

  const filePath = resolve(dir, `${target.fileName}.html`);
  const { document } = readFileAsDocument(filePath);

  const htmlId = params.id || inferSmHtmlId(data.name);
  const existing = findElementById(document, htmlId);
  if (!existing) {
    return { ok: false, error: `State machine element not found: ${htmlId}` };
  }

  existing.remove();
  const element = createStateMachineElement(document, data);
  appendToMain(document, element);
  writeDocumentToFile(document, filePath);

  const newHtmlId = inferSmHtmlId(data.name);
  return makeResult('update', 'sm', target.fileName, data.name, newHtmlId);
}

export async function delete_(index, dir, params) {
  const target = resolveTargetFile(index, 'sm', params);
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
    return { ok: false, error: `State machine element not found: ${htmlId}` };
  }

  const smName = element.getAttribute('data-state-machine') || htmlId;
  element.remove();
  writeDocumentToFile(document, filePath);

  return makeResult('delete', 'sm', target.fileName, smName, htmlId);
}

export { delete_ as delete };

export function list(index, params) {
  const results = [];
  for (const doc of index.docs) {
    const elements = doc.document.querySelectorAll('[data-state-machine]');
    for (const el of elements) {
      results.push({
        id: el.getAttribute('data-state-machine') || '',
        name: el.getAttribute('data-state-machine') || '',
        file: doc.fileName,
      });
    }
  }
  return { ok: true, action: 'list', type: 'sm', items: results };
}
