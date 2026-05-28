/**
 * HTML 生成工具 — 通过 linkedom DOM API 创建 SPEC 元素节点
 * 100% DOM 操作，零字符串拼接。
 */

import { parseHTML } from 'linkedom';
import { readFileSync, writeFileSync } from 'node:fs';
import { escapeHtml } from '../utils/html.mjs';
import { slugify, pathToId } from '../utils/normalize.mjs';
import { inferDomain, parseReqId, parseTestId } from '../utils/schemas.mjs';
import { isKnownSpecType } from '../schema/type-system.mjs';

export function inferReqHtmlId(reqId) {
  const parsed = parseReqId(reqId);
  if (!parsed) return `req-${slugify(reqId)}`;
  return `req-${parsed.domain.toLowerCase()}-${parsed.number}`;
}

export function inferEntityHtmlId(name) {
  return `data-${name.toLowerCase()}`;
}

export function inferApiHtmlId(method, path) {
  return `api-${method.toLowerCase()}-${pathToId(path)}`;
}

export function inferTestHtmlId(testId) {
  const parsed = parseTestId(testId);
  if (!parsed) return `test-${slugify(testId)}`;
  return `test-${parsed.domain.toLowerCase()}-${parsed.number}`;
}

export function inferSmHtmlId(name) {
  return `sm-${slugify(name)}`;
}

export function createReqElement(document, data) {
  const section = document.createElement('section');
  section.setAttribute('id', inferReqHtmlId(data.id));
  section.setAttribute('data-req', data.id);
  section.setAttribute('data-req-status', data.status || 'unknown');
  section.setAttribute('data-req-domain', data.domain || inferDomain(data.id));
  if (data.priority) section.setAttribute('data-req-priority', data.priority);

  const tag = document.createElement('h3');
  tag.textContent = `${data.id} ${data.title}`;
  section.appendChild(tag);

  if (data.description) {
    const p = document.createElement('p');
    p.textContent = data.description;
    section.appendChild(p);
  }

  for (const text of (data.criteria || [])) {
    const div = document.createElement('div');
    div.setAttribute('data-criterion', text);
    div.textContent = text;
    section.appendChild(div);
  }

  return section;
}

export function createEntityElement(document, data) {
  const section = document.createElement('section');
  section.setAttribute('id', inferEntityHtmlId(data.name));
  section.setAttribute('data-entity', data.name);

  const tag = document.createElement('h3');
  tag.textContent = `${data.name} ${data.title || ''}`;
  section.appendChild(tag);

  if (data.fields && data.fields.length > 0) {
    const table = document.createElement('table');
    table.setAttribute('data-entity-table', data.name);

    const headerRow = document.createElement('tr');
    for (const h of ['字段', '类型', '必填', '约束', '说明']) {
      const th = document.createElement('th');
      th.textContent = h;
      headerRow.appendChild(th);
    }
    table.appendChild(headerRow);

    for (const f of data.fields) {
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
    section.appendChild(table);
  }

  if (data.relations && data.relations.length > 0) {
    const script = document.createElement('script');
    script.setAttribute('type', 'application/ld+json');
    script.textContent = JSON.stringify({
      '@type': 'EntityRelations',
      entity: data.name,
      relations: data.relations,
    }, null, 2);
    section.appendChild(script);
  }

  return section;
}

export function createApiElement(document, data) {
  const section = document.createElement('section');
  const method = (data.method || 'GET').toUpperCase();
  const path = data.path;
  section.setAttribute('id', inferApiHtmlId(method, path));
  section.setAttribute('data-api', `${method} ${path}`);

  const tag = document.createElement('h4');
  tag.textContent = `${method} ${path}`;
  if (data.title) tag.textContent += ` — ${data.title}`;
  section.appendChild(tag);

  if (data.role) {
    section.setAttribute('data-api-role', data.role);
  }

  if (data.params && data.params.length > 0) {
    const table = document.createElement('table');
    table.setAttribute('data-api-params', '');

    const headerRow = document.createElement('tr');
    for (const h of ['参数', '类型', '必填', '说明']) {
      const th = document.createElement('th');
      th.textContent = h;
      headerRow.appendChild(th);
    }
    table.appendChild(headerRow);

    for (const p of data.params) {
      const tr = document.createElement('tr');
      tr.setAttribute('data-param', p.name);
      tr.setAttribute('data-type', p.type || 'string');
      tr.setAttribute('data-required', String(!!p.required));

      for (const val of [p.name, p.type || 'string', p.required ? '是' : '否', p.description || '']) {
        const td = document.createElement('td');
        td.textContent = val;
        tr.appendChild(td);
      }
      table.appendChild(tr);
    }
    section.appendChild(table);
  }

  if (data.response) {
    const script = document.createElement('script');
    script.setAttribute('type', 'application/ld+json');
    script.textContent = JSON.stringify({
      '@type': 'ApiResponse',
      source: 'example',
      body: data.response,
    }, null, 2);
    section.appendChild(script);
  }

  return section;
}

export function createTestElement(document, data) {
  const section = document.createElement('section');
  section.setAttribute('id', inferTestHtmlId(data.id));
  section.setAttribute('data-test', data.id);
  if (data.reqRef) section.setAttribute('data-req-ref', data.reqRef);
  if (data.categories) section.setAttribute('data-test-categories', data.categories.join(','));

  const tag = document.createElement('h3');
  tag.textContent = `${data.id} ${data.title}`;
  section.appendChild(tag);

  if (data.description) {
    const p = document.createElement('p');
    p.textContent = data.description;
    section.appendChild(p);
  }

  return section;
}

export function createStateMachineElement(document, data) {
  const section = document.createElement('section');
  section.setAttribute('id', inferSmHtmlId(data.name));
  section.setAttribute('data-state-machine', data.name);

  const tag = document.createElement('h3');
  tag.textContent = `${data.name} 状态机`;
  section.appendChild(tag);

  if (data.states && data.transitions) {
    const script = document.createElement('script');
    script.setAttribute('type', 'application/ld+json');
    script.textContent = JSON.stringify({
      '@type': 'StateMachine',
      name: data.name,
      states: data.states,
      initialState: data.initialState || data.states[0],
      transitions: data.transitions,
    }, null, 2);
    section.appendChild(script);
  }

  return section;
}

export function createIndexStrategySection(document, indexes) {
  const section = document.createElement('div');
  section.setAttribute('data-index-strategy', '');

  const table = document.createElement('table');
  table.setAttribute('data-index-table', '');

  const headerRow = document.createElement('tr');
  for (const h of ['索引名', '字段', '类型', '唯一', '条件']) {
    const th = document.createElement('th');
    th.textContent = h;
    headerRow.appendChild(th);
  }
  table.appendChild(headerRow);

  for (const idx of indexes) {
    const tr = document.createElement('tr');
    const vals = [idx.name, idx.fields, idx.type || 'B-tree', idx.unique ? '是' : '否', idx.condition || ''];
    for (const v of vals) {
      const td = document.createElement('td');
      td.textContent = v;
      tr.appendChild(td);
    }
    table.appendChild(tr);
  }

  section.appendChild(table);
  return section;
}

export function createJsonSchemaSection(document, field, schema) {
  const section = document.createElement('div');
  section.setAttribute('data-json-schema', field);

  const script = document.createElement('script');
  script.setAttribute('type', 'application/ld+json');
  script.textContent = JSON.stringify({ '@type': 'FieldSchema', field, schema }, null, 2);
  section.appendChild(script);

  return section;
}

export function createApiGroupElement(document, group, title) {
  const section = document.createElement('section');
  section.setAttribute('data-api-group', group);

  const h = document.createElement('h3');
  h.textContent = title || group;
  section.appendChild(h);

  return section;
}

export function createArtifactElement(document, data) {
  const section = document.createElement('section');
  section.setAttribute('id', data.id);
  section.setAttribute('data-artifact-type', data.type);

  const h = document.createElement('h3');
  h.textContent = data.title || data.type;
  section.appendChild(h);

  if (data.content) {
    const contentEl = document.createElement('div');
    contentEl.innerHTML = data.content;
    section.appendChild(contentEl);
  }

  return section;
}

export function createXrefElement(document, targetFile, targetId, type, text) {
  const a = document.createElement('a');
  a.setAttribute('href', `${targetFile}.html#${targetId}`);
  a.setAttribute('data-xref-type', type);
  a.setAttribute('data-xref-id', targetId);
  a.textContent = text;
  return a;
}

export function readFileAsDocument(filePath) {
  const raw = readFileSync(filePath, 'utf8');
  const { document } = parseHTML(raw);
  return { document, raw };
}

export function writeDocumentToFile(document, filePath) {
  writeFileSync(filePath, document.toString(), 'utf8');
}

// === 5 新维度元素生成 ===

export function inferAlgorithmHtmlId(name) {
  return `alg-${slugify(name)}`;
}

export function createAlgorithmElement(document, data) {
  const section = document.createElement('section');
  section.setAttribute('id', inferAlgorithmHtmlId(data.name));
  section.setAttribute('data-algorithm', data.name);
  if (data.type) section.setAttribute('data-algorithm-type', data.type);
  if (data.complexity) section.setAttribute('data-algorithm-complexity', data.complexity);
  if (data.space) section.setAttribute('data-algorithm-space', data.space);

  const h = document.createElement('h3');
  h.textContent = data.title || data.name;
  section.appendChild(h);

  if (data.description) {
    const p = document.createElement('p');
    p.textContent = data.description;
    section.appendChild(p);
  }

  if (data.pseudocode) {
    const pre = document.createElement('pre');
    pre.setAttribute('data-algorithm-pseudocode', '');
    pre.textContent = data.pseudocode;
    section.appendChild(pre);
  }

  if (data.constraints && data.constraints.length > 0) {
    const script = document.createElement('script');
    script.setAttribute('type', 'application/ld+json');
    script.textContent = JSON.stringify({
      '@type': 'Algorithm',
      name: data.name,
      complexity: data.complexity,
      space: data.space,
      pseudocode: data.pseudocode,
      constraints: data.constraints,
    }, null, 2);
    section.appendChild(script);
  }

  return section;
}

export function inferPipelineHtmlId(name) {
  return `pipe-${slugify(name)}`;
}

export function createPipelineElement(document, data) {
  const section = document.createElement('section');
  section.setAttribute('id', inferPipelineHtmlId(data.name));
  section.setAttribute('data-pipeline', data.name);
  if (data.type) section.setAttribute('data-pipeline-type', data.type);

  const h = document.createElement('h3');
  h.textContent = data.title || data.name;
  section.appendChild(h);

  if (data.description) {
    const p = document.createElement('p');
    p.textContent = data.description;
    section.appendChild(p);
  }

  if (data.stages && data.stages.length > 0) {
    const script = document.createElement('script');
    script.setAttribute('type', 'application/ld+json');
    script.textContent = JSON.stringify({
      '@type': 'Pipeline',
      name: data.name,
      stages: data.stages,
    }, null, 2);
    section.appendChild(script);

    const table = document.createElement('table');
    table.setAttribute('data-pipeline-stages', data.name);
    const headerRow = document.createElement('tr');
    for (const col of ['阶段', '输入', '输出', '变换']) {
      const th = document.createElement('th');
      th.textContent = col;
      headerRow.appendChild(th);
    }
    table.appendChild(headerRow);
    for (const s of data.stages) {
      const tr = document.createElement('tr');
      for (const val of [s.name, s.input || '', s.output || '', s.transform || '']) {
        const td = document.createElement('td');
        td.textContent = val;
        tr.appendChild(td);
      }
      table.appendChild(tr);
    }
    section.appendChild(table);
  }

  return section;
}

export function inferIntegrationHtmlId(name) {
  return `int-${slugify(name)}`;
}

export function createIntegrationElement(document, data) {
  const section = document.createElement('section');
  section.setAttribute('id', inferIntegrationHtmlId(data.name));
  section.setAttribute('data-integration', data.name);
  if (data.protocol) section.setAttribute('data-integration-protocol', data.protocol);
  if (data.auth) section.setAttribute('data-integration-auth', data.auth);

  const h = document.createElement('h3');
  h.textContent = data.title || data.name;
  section.appendChild(h);

  if (data.description) {
    const p = document.createElement('p');
    p.textContent = data.description;
    section.appendChild(p);
  }

  const jsonld = {
    '@type': 'Integration',
    name: data.name,
    protocol: data.protocol,
    auth: data.auth,
    endpoints: data.endpoints || [],
  };
  if (data.rateLimit) jsonld.rateLimit = data.rateLimit;
  if (data.fallback) jsonld.fallback = data.fallback;

  const script = document.createElement('script');
  script.setAttribute('type', 'application/ld+json');
  script.textContent = JSON.stringify(jsonld, null, 2);
  section.appendChild(script);

  return section;
}

export function inferTimingHtmlId(name) {
  return `tmg-${slugify(name)}`;
}

export function createTimingElement(document, data) {
  const section = document.createElement('section');
  section.setAttribute('id', inferTimingHtmlId(data.name));
  section.setAttribute('data-timing', data.name);
  if (data.constraint) section.setAttribute('data-timing-constraint', data.constraint);

  const h = document.createElement('h3');
  h.textContent = data.title || data.name;
  section.appendChild(h);

  if (data.description) {
    const p = document.createElement('p');
    p.textContent = data.description;
    section.appendChild(p);
  }

  if (data.target || data.unit || data.scope) {
    const table = document.createElement('table');
    table.setAttribute('data-timing-params', '');
    const headerRow = document.createElement('tr');
    for (const col of ['约束', '目标值', '单位', '范围']) {
      const th = document.createElement('th');
      th.textContent = col;
      headerRow.appendChild(th);
    }
    table.appendChild(headerRow);
    const tr = document.createElement('tr');
    for (const val of [data.constraint || '', data.target || '', data.unit || '', data.scope || '']) {
      const td = document.createElement('td');
      td.textContent = val;
      tr.appendChild(td);
    }
    table.appendChild(tr);
    section.appendChild(table);
  }

  if (data.retryPolicy || data.target) {
    const script = document.createElement('script');
    script.setAttribute('type', 'application/ld+json');
    const jsonld = { '@type': 'TimingConstraint', name: data.name, constraint: data.constraint, target: data.target, unit: data.unit, scope: data.scope };
    if (data.retryPolicy) jsonld.retryPolicy = data.retryPolicy;
    script.textContent = JSON.stringify(jsonld, null, 2);
    section.appendChild(script);
  }

  return section;
}

export function inferNfrHtmlId(name) {
  return `nfr-${slugify(name)}`;
}

export function createNfrElement(document, data) {
  const section = document.createElement('section');
  section.setAttribute('id', inferNfrHtmlId(data.name));
  section.setAttribute('data-nfr', data.name);
  if (data.category) section.setAttribute('data-nfr-category', data.category);

  const h = document.createElement('h3');
  h.textContent = data.title || data.name;
  section.appendChild(h);

  if (data.description) {
    const p = document.createElement('p');
    p.textContent = data.description;
    section.appendChild(p);
  }

  if (data.metrics && data.metrics.length > 0) {
    const table = document.createElement('table');
    table.setAttribute('data-nfr-metrics', '');
    const headerRow = document.createElement('tr');
    for (const col of ['指标', '运算符', '阈值', '单位']) {
      const th = document.createElement('th');
      th.textContent = col;
      headerRow.appendChild(th);
    }
    table.appendChild(headerRow);
    for (const m of data.metrics) {
      const tr = document.createElement('tr');
      for (const val of [m.name, m.operator, m.threshold, m.unit || '']) {
        const td = document.createElement('td');
        td.textContent = val;
        tr.appendChild(td);
      }
      table.appendChild(tr);
    }
    section.appendChild(table);
  }

  const jsonld = { '@type': 'NFR', name: data.name, category: data.category, metrics: data.metrics || [] };
  if (data.regulation) jsonld.regulation = data.regulation;

  const script = document.createElement('script');
  script.setAttribute('type', 'application/ld+json');
  script.textContent = JSON.stringify(jsonld, null, 2);
  section.appendChild(script);

  return section;
}
