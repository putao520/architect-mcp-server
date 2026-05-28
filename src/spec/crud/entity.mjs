/**
 * Entity CRUD handler — 数据实体的创建/读取/更新/删除/列表
 */

import { z } from 'zod';
import { resolve } from 'node:path';
import { resolveTargetFile, findElementById, appendToMain, makeResult } from './engine.mjs';
import {
  createEntityElement,
  createIndexStrategySection,
  createJsonSchemaSection,
  readFileAsDocument,
  writeDocumentToFile,
  inferEntityHtmlId,
} from './html-gen.mjs';
import { isKnownSpecType } from '../schema/type-system.mjs';

const FIELD_SCHEMA = z.object({
  name: z.string(),
  type: z.string().refine(isKnownSpecType, { message: 'Unknown SPEC type' }),
  required: z.boolean(),
  constraints: z.string().optional(),
  description: z.string().optional(),
});

const CREATE_DATA = z.object({
  name: z.string(),
  title: z.string().optional(),
  fields: z.array(FIELD_SCHEMA).optional(),
  indexes: z.array(z.object({
    name: z.string(),
    fields: z.string(),
    type: z.string().optional(),
    unique: z.boolean().optional(),
    condition: z.string().optional(),
  })).optional(),
  jsonSchemas: z.array(z.object({
    field: z.string(),
    schema: z.any(),
  })).optional(),
  relations: z.array(z.object({
    target: z.string(),
    type: z.string(),
  })).optional(),
});

export function list(index) {
  return index.allEntities.map(e => ({
    id: e.id,
    htmlId: e.id,
    name: e.name,
    title: e.title,
    fieldCount: e.fields?.length || 0,
    file: index.entityByName.get(e.name)?.doc?.fileName,
  }));
}

export function read(index, params) {
  const name = params.name || params.id;
  if (!name) return { ok: false, error: 'Missing params.name or params.id' };

  const entry = index.entityByName.get(name);
  if (!entry) return { ok: false, error: `Entity not found: ${name}` };

  const entity = entry.entity;
  return {
    ok: true,
    id: entity.id,
    htmlId: entity.id,
    name: entity.name,
    title: entity.title,
    fields: entity.fields,
    indexes: entity.indexes,
    jsonSchemas: entity.jsonSchemas,
    xrefs: entity.xrefs,
    file: entry.doc?.fileName,
  };
}

export async function create(index, dir, params) {
  const data = CREATE_DATA.parse(params.data);
  const target = resolveTargetFile(index, 'entity', params);
  if (!target) return { ok: false, error: 'No target file resolved for entity' };

  const { fileName } = target;
  const filePath = resolve(dir, `${fileName}.html`);

  if (index.entityByName.has(data.name)) {
    return { ok: false, error: `Entity already exists: ${data.name}` };
  }

  const { document } = readFileAsDocument(filePath);
  const element = createEntityElement(document, data);

  if (data.indexes && data.indexes.length > 0) {
    element.appendChild(createIndexStrategySection(document, data.indexes));
  }

  if (data.jsonSchemas && data.jsonSchemas.length > 0) {
    for (const { field, schema } of data.jsonSchemas) {
      element.appendChild(createJsonSchemaSection(document, field, schema));
    }
  }

  appendToMain(document, element);
  writeDocumentToFile(document, filePath);

  return makeResult('create', 'entity', fileName, data.name, inferEntityHtmlId(data.name));
}

export async function update(index, dir, params) {
  const name = params.name || params.id;
  if (!name) return { ok: false, error: 'Missing entity name for update' };

  const entry = index.entityByName.get(name);
  if (!entry) return { ok: false, error: `Entity not found: ${name}` };

  const ownerDoc = entry.doc;
  const htmlId = inferEntityHtmlId(name);
  const filePath = resolve(dir, `${ownerDoc.fileName}.html`);
  const { document } = readFileAsDocument(filePath);
  const element = findElementById(document, htmlId);
  if (!element) return { ok: false, error: `Element not found in DOM: ${htmlId}` };

  const patch = params.data || {};

  if (patch.title) {
    const heading = element.querySelector('h1, h2, h3, h4, h5, h6');
    if (heading) heading.textContent = `${name} ${patch.title}`;
  }

  if (patch.fields) {
    for (const f of patch.fields) {
      if (!isKnownSpecType(f.type)) {
        return { ok: false, error: `Unknown SPEC type for field "${f.name}": ${f.type}` };
      }
    }

    const existingTable = element.querySelector('table[data-entity-table]');
    if (existingTable) existingTable.remove();

    if (patch.fields.length > 0) {
      const table = document.createElement('table');
      table.setAttribute('data-entity-table', name);

      const headerRow = document.createElement('tr');
      for (const h of ['字段', '类型', '必填', '约束', '说明']) {
        const th = document.createElement('th');
        th.textContent = h;
        headerRow.appendChild(th);
      }
      table.appendChild(headerRow);

      for (const f of patch.fields) {
        const tr = document.createElement('tr');
        tr.setAttribute('data-field', f.name);
        tr.setAttribute('data-type', f.type);
        tr.setAttribute('data-required', String(!!f.required));
        if (f.constraints) tr.setAttribute('data-constraints', f.constraints);

        for (const val of [f.name, f.type, f.required ? '是' : '否', f.constraints || '', f.description || '']) {
          const td = document.createElement('td');
          td.textContent = val;
          tr.appendChild(td);
        }
        table.appendChild(tr);
      }
      element.appendChild(table);
    }
  }

  if (patch.addField) {
    const f = patch.addField;
    if (!isKnownSpecType(f.type)) {
      return { ok: false, error: `Unknown SPEC type for addField "${f.name}": ${f.type}` };
    }
    let table = element.querySelector('table[data-entity-table]');
    if (!table) {
      table = document.createElement('table');
      table.setAttribute('data-entity-table', name);
      const headerRow = document.createElement('tr');
      for (const h of ['字段', '类型', '必填', '约束', '说明']) {
        const th = document.createElement('th');
        th.textContent = h;
        headerRow.appendChild(th);
      }
      table.appendChild(headerRow);
      element.appendChild(table);
    }
    const tr = document.createElement('tr');
    tr.setAttribute('data-field', f.name);
    tr.setAttribute('data-type', f.type);
    tr.setAttribute('data-required', String(!!f.required));
    if (f.constraints) tr.setAttribute('data-constraints', f.constraints);
    for (const val of [f.name, f.type, f.required ? '是' : '否', f.constraints || '', f.description || '']) {
      const td = document.createElement('td');
      td.textContent = val;
      tr.appendChild(td);
    }
    table.appendChild(tr);
  }

  if (patch.removeField) {
    const row = element.querySelector(`tr[data-field="${patch.removeField}"]`);
    if (row) row.remove();
  }

  if (patch.updateField) {
    const f = patch.updateField;
    const row = element.querySelector(`tr[data-field="${f.name}"]`);
    if (row) {
      if (f.type) {
        if (!isKnownSpecType(f.type)) {
          return { ok: false, error: `Unknown SPEC type for updateField "${f.name}": ${f.type}` };
        }
        row.setAttribute('data-type', f.type);
      }
      if (f.required !== undefined) row.setAttribute('data-required', String(!!f.required));
      if (f.constraints !== undefined) row.setAttribute('data-constraints', f.constraints);
      const cells = row.querySelectorAll('td');
      if (cells.length >= 5) {
        if (f.type) cells[1].textContent = f.type;
        if (f.required !== undefined) cells[2].textContent = f.required ? '是' : '否';
        if (f.constraints !== undefined) cells[3].textContent = f.constraints;
        if (f.description !== undefined) cells[4].textContent = f.description;
      }
    }
  }

  if (patch.relations) {
    const oldScript = element.querySelector('script[type="application/ld+json"]');
    if (oldScript) {
      try {
        const parsed = JSON.parse(oldScript.textContent);
        if (parsed['@type'] === 'EntityRelations') oldScript.remove();
      } catch { /* keep non-relation scripts */ }
    }
    const script = document.createElement('script');
    script.setAttribute('type', 'application/ld+json');
    script.textContent = JSON.stringify({
      '@type': 'EntityRelations',
      entity: name,
      relations: patch.relations,
    }, null, 2);
    element.appendChild(script);
  }

  // === Index Strategy 管理 ===

  if (patch.indexes) {
    const oldSection = element.querySelector('[data-index-strategy]');
    if (oldSection) oldSection.remove();
    if (patch.indexes.length > 0) {
      element.appendChild(createIndexStrategySection(document, patch.indexes));
    }
  }

  if (patch.addIndex) {
    let section = element.querySelector('[data-index-strategy]');
    if (!section) {
      section = createIndexStrategySection(document, [patch.addIndex]);
      element.appendChild(section);
    } else {
      const table = section.querySelector('table[data-index-table]');
      if (table) {
        const tr = document.createElement('tr');
        const idx = patch.addIndex;
        for (const v of [idx.name, idx.fields, idx.type || 'B-tree', idx.unique ? '是' : '否', idx.condition || '']) {
          const td = document.createElement('td');
          td.textContent = v;
          tr.appendChild(td);
        }
        table.appendChild(tr);
      }
    }
  }

  if (patch.removeIndex) {
    const section = element.querySelector('[data-index-strategy]');
    if (section) {
      const rows = section.querySelectorAll('table[data-index-table] tr');
      for (const row of rows) {
        const firstTd = row.querySelector('td');
        if (firstTd && firstTd.textContent.trim() === patch.removeIndex) {
          row.remove();
          break;
        }
      }
    }
  }

  // === JSON Schema 管理 ===

  if (patch.addJsonSchema) {
    const { field, schema } = patch.addJsonSchema;
    const old = element.querySelector(`[data-json-schema="${field}"]`);
    if (old) old.remove();
    element.appendChild(createJsonSchemaSection(document, field, schema));
  }

  if (patch.removeJsonSchema) {
    const old = element.querySelector(`[data-json-schema="${patch.removeJsonSchema}"]`);
    if (old) old.remove();
  }

  writeDocumentToFile(document, filePath);
  return makeResult('update', 'entity', ownerDoc.fileName, name, htmlId);
}

export async function delete_(index, dir, params) {
  const name = params.name || params.id;
  if (!name) return { ok: false, error: 'Missing entity name for delete' };

  const entry = index.entityByName.get(name);
  if (!entry) return { ok: false, error: `Entity not found: ${name}` };

  const htmlId = inferEntityHtmlId(name);
  const filePath = resolve(dir, `${entry.doc.fileName}.html`);
  const { document } = readFileAsDocument(filePath);
  const element = findElementById(document, htmlId);
  if (!element) return { ok: false, error: `Element not found in DOM: ${htmlId}` };

  element.remove();
  writeDocumentToFile(document, filePath);
  return makeResult('delete', 'entity', entry.doc.fileName, name, htmlId);
}

export { delete_ as delete };
