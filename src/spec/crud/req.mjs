/**
 * REQ CRUD handler — REQ 条目的创建/读取/更新/删除/列表
 */

import { z } from 'zod';
import { resolve } from 'node:path';
import { resolveTargetFile, findElementById, appendToMain, makeResult } from './engine.mjs';
import {
  createReqElement,
  readFileAsDocument,
  writeDocumentToFile,
  inferReqHtmlId,
} from './html-gen.mjs';
import { ReqIdSchema, inferDomain, parseReqId } from '../utils/schemas.mjs';

const CREATE_DATA = z.object({
  id: ReqIdSchema,
  status: z.enum(['draft', 'approved', 'implemented', 'unknown']).optional(),
  priority: z.string().optional(),
  title: z.string(),
  description: z.string().optional(),
  criteria: z.array(z.string()).optional(),
  domain: z.string().optional(),
});

export function list(index) {
  return index.allReqs.map(r => ({
    id: r.id,
    htmlId: r.htmlId,
    status: r.status,
    domain: r.domain,
    title: r.title,
    file: index.reqMap.get(r.id)
      ? index.fileMap.get(index.docs.find(d => d.reqs.some(dr => dr.id === r.id))?.fileName)?.fileName
      : undefined,
  }));
}

export function read(index, params) {
  const reqId = params.id;
  if (!reqId) return { ok: false, error: 'Missing params.id' };

  const entry = index.reqMap.get(reqId);
  if (!entry) return { ok: false, error: `REQ not found: ${reqId}` };

  const ownerDoc = index.docs.find(d => d.reqs.some(r => r.id === reqId));
  return {
    ok: true,
    id: entry.id,
    htmlId: entry.htmlId,
    status: entry.status,
    domain: entry.domain,
    priority: entry.priority,
    title: entry.title,
    criteria: entry.criteria,
    xrefs: entry.xrefs,
    file: ownerDoc?.fileName,
  };
}

export async function create(index, dir, params) {
  const data = CREATE_DATA.parse(params.data);
  const target = resolveTargetFile(index, 'req', params);
  if (!target) return { ok: false, error: 'No target file resolved for REQ' };

  const { doc: targetDoc, fileName } = target;
  const filePath = resolve(dir, `${fileName}.html`);
  const { document } = readFileAsDocument(filePath);

  const existing = document.querySelector(`[data-req="${data.id}"]`);
  if (existing) return { ok: false, error: `REQ already exists: ${data.id}` };

  const element = createReqElement(document, data);
  appendToMain(document, element);
  writeDocumentToFile(document, filePath);

  return makeResult('create', 'req', fileName, data.id, inferReqHtmlId(data.id));
}

export async function update(index, dir, params) {
  const htmlId = params.htmlId || (params.id ? inferReqHtmlId(params.id) : null);
  if (!htmlId) return { ok: false, error: 'Missing htmlId or id for update' };

  const ownerDoc = index.docs.find(d => {
    const { document } = readFileAsDocument(resolve(dir, `${d.fileName}.html`));
    return !!document.getElementById(htmlId);
  });
  if (!ownerDoc) return { ok: false, error: `Element not found: ${htmlId}` };

  const filePath = resolve(dir, `${ownerDoc.fileName}.html`);
  const { document } = readFileAsDocument(filePath);
  const element = findElementById(document, htmlId);
  if (!element) return { ok: false, error: `Element not found in DOM: ${htmlId}` };

  const patch = params.data || {};
  if (patch.status) element.setAttribute('data-req-status', patch.status);
  if (patch.priority) element.setAttribute('data-req-priority', patch.priority);
  if (patch.domain) element.setAttribute('data-req-domain', patch.domain);
  if (patch.title) {
    const heading = element.querySelector('h1, h2, h3, h4, h5, h6');
    const reqId = element.getAttribute('data-req');
    if (heading) heading.textContent = `${reqId} ${patch.title}`;
  }
  if (patch.description) {
    let desc = element.querySelector('p[data-req-description]');
    if (!desc) {
      desc = document.createElement('p');
      desc.setAttribute('data-req-description', '');
      const heading = element.querySelector('h1, h2, h3, h4, h5, h6');
      if (heading && heading.nextSibling) {
        element.insertBefore(desc, heading.nextSibling);
      } else {
        element.appendChild(desc);
      }
    }
    desc.textContent = patch.description;
  }
  if (patch.criteria) {
    for (const old of [...element.querySelectorAll('[data-criterion]')]) old.remove();
    for (const text of patch.criteria) {
      const div = document.createElement('div');
      div.setAttribute('data-criterion', text);
      div.textContent = text;
      element.appendChild(div);
    }
  }

  writeDocumentToFile(document, filePath);
  return makeResult('update', 'req', ownerDoc.fileName, params.id, htmlId);
}

export async function delete_(index, dir, params) {
  const htmlId = params.htmlId || (params.id ? inferReqHtmlId(params.id) : null);
  if (!htmlId) return { ok: false, error: 'Missing htmlId or id for delete' };

  for (const doc of index.docs) {
    const filePath = resolve(dir, `${doc.fileName}.html`);
    const { document } = readFileAsDocument(filePath);
    const element = findElementById(document, htmlId);
    if (element) {
      element.remove();
      writeDocumentToFile(document, filePath);
      return makeResult('delete', 'req', doc.fileName, params.id, htmlId);
    }
  }

  return { ok: false, error: `Element not found: ${htmlId}` };
}

export { delete_ as delete };
