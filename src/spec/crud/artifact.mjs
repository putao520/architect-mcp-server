/**
 * Artifact CRUD handler — 28 种设计产物的统一增删改查
 * 通过 completeness.mjs 的 ARTIFACT_DEFS 路由到目标文件。
 */

import { z } from 'zod';
import { resolve } from 'node:path';
import { resolveTargetFile, findElementById, appendToMain, makeResult } from './engine.mjs';
import { createArtifactElement, readFileAsDocument, writeDocumentToFile } from './html-gen.mjs';

const ARTIFACT_TYPES = [
  'function-module-tree', 'use-case-diagram', 'metrics-dimension',
  'runtime-state', 'interface-protocol', 'event-catalog',
  'error-strategy', 'dependency-matrix', 'state-machine',
  'model-tree', 'cache-index-strategy', 'env-config-matrix',
  'permission-matrix', 'data-classification', 'observability',
  'route-tree', 'component-tree', 'mock-strategy',
  'ux-interaction-patterns', 'ui-source-mapping',
  'state-semantic-dict', 'interaction-patterns', 'info-architecture',
  'design-tokens', 'user-journey', 'usability-framework',
];

const ARTIFACT_FILE_MAP = {
  'function-module-tree': '01-BUSINESS', 'use-case-diagram': '01-BUSINESS', 'metrics-dimension': '01-BUSINESS',
  'runtime-state': '02-SYSTEM', 'interface-protocol': '02-SYSTEM', 'event-catalog': '02-SYSTEM',
  'error-strategy': '02-SYSTEM', 'dependency-matrix': '02-SYSTEM',
  'state-machine': '03-PROCESS',
  'model-tree': '04-DATA-MODEL', 'cache-index-strategy': '04-DATA-MODEL',
  'env-config-matrix': '05-DEPLOYMENT',
  'permission-matrix': '06-SECURITY', 'data-classification': '06-SECURITY',
  'observability': '07-OPERATIONS',
  'route-tree': '08-PAGES', 'component-tree': '08-PAGES',
  'ux-interaction-patterns': '08-PAGES', 'ui-source-mapping': '08-PAGES',
  'mock-strategy': '11-TESTING',
  'state-semantic-dict': '13-UX-DESIGN', 'interaction-patterns': '13-UX-DESIGN',
  'info-architecture': '13-UX-DESIGN', 'design-tokens': '13-UX-DESIGN',
  'user-journey': '13-UX-DESIGN', 'usability-framework': '13-UX-DESIGN',
};

const CREATE_DATA = z.object({
  type: z.string(),
  id: z.string().optional(),
  title: z.string().optional(),
  content: z.string().optional(),
});

function resolveArtifactFile(index, artifactType, params) {
  if (params.file) {
    const name = params.file.replace(/\.html$/, '');
    return index.fileMap.has(name) ? name : null;
  }
  return ARTIFACT_FILE_MAP[artifactType] || null;
}

export async function create(index, dir, params) {
  const data = CREATE_DATA.parse(params.data);
  const targetFile = resolveArtifactFile(index, data.type, params);
  if (!targetFile) {
    return { ok: false, error: `No target file for artifact type: ${data.type}` };
  }

  const artifactId = data.id || `artifact-${data.type}`;
  const filePath = resolve(dir, `${targetFile}.html`);
  const { document } = readFileAsDocument(filePath);

  if (findElementById(document, artifactId)) {
    return { ok: false, error: `Artifact already exists: ${artifactId}` };
  }

  const artifactData = { id: artifactId, type: data.type, title: data.title, content: data.content };
  const element = createArtifactElement(document, artifactData);
  appendToMain(document, element);
  writeDocumentToFile(document, filePath);

  return makeResult('create', 'artifact', targetFile, artifactId, artifactId);
}

export function read(index, params) {
  const artifactId = params.id;
  if (!artifactId) return { ok: false, error: 'Missing params.id for artifact read' };

  for (const doc of index.docs) {
    const artifact = doc.artifacts.find(a => a.id === artifactId);
    if (artifact) {
      return {
        ok: true,
        id: artifact.id,
        type: artifact.type,
        title: artifact.title,
        file: doc.fileName,
      };
    }
  }
  return { ok: false, error: `Artifact not found: ${artifactId}` };
}

export async function update(index, dir, params) {
  const artifactId = params.id;
  if (!artifactId) return { ok: false, error: 'Missing params.id for artifact update' };

  const patch = params.data || {};

  for (const doc of index.docs) {
    const artifact = doc.artifacts.find(a => a.id === artifactId);
    if (!artifact) continue;

    const filePath = resolve(dir, `${doc.fileName}.html`);
    const { document } = readFileAsDocument(filePath);
    const element = findElementById(document, artifactId);
    if (!element) return { ok: false, error: `Artifact element not found in DOM: ${artifactId}` };

    if (patch.title) {
      const h = element.querySelector('h3, h4');
      if (h) h.textContent = patch.title;
    }
    if (patch.content) {
      const contentEl = element.querySelector('div') || document.createElement('div');
      contentEl.innerHTML = patch.content;
      if (!element.contains(contentEl)) element.appendChild(contentEl);
    }

    writeDocumentToFile(document, filePath);
    return makeResult('update', 'artifact', doc.fileName, artifactId, artifactId);
  }

  return { ok: false, error: `Artifact not found: ${artifactId}` };
}

export async function delete_(index, dir, params) {
  const artifactId = params.id;
  if (!artifactId) return { ok: false, error: 'Missing params.id for artifact delete' };

  for (const doc of index.docs) {
    const artifact = doc.artifacts.find(a => a.id === artifactId);
    if (!artifact) continue;

    const filePath = resolve(dir, `${doc.fileName}.html`);
    const { document } = readFileAsDocument(filePath);
    const element = findElementById(document, artifactId);
    if (!element) return { ok: false, error: `Artifact element not found in DOM: ${artifactId}` };

    element.remove();
    writeDocumentToFile(document, filePath);
    return makeResult('delete', 'artifact', doc.fileName, artifactId, artifactId);
  }

  return { ok: false, error: `Artifact not found: ${artifactId}` };
}

export { delete_ as delete };

export function list(index, params) {
  const filter = params.data || params;
  const results = [];

  for (const doc of index.docs) {
    for (const a of doc.artifacts) {
      if (filter.type && a.type !== filter.type) continue;
      if (filter.file && doc.fileName !== filter.file.replace(/\.html$/, '')) continue;
      results.push({
        id: a.id,
        type: a.type,
        title: a.title,
        file: doc.fileName,
      });
    }
  }

  return { ok: true, action: 'list', type: 'artifact', items: results };
}
