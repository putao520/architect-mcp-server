/**
 * 通用提取器 — 从 HTML SPEC DOM 提取结构化数据
 * 供 html-parser、验证器、迁移器、图分析器复用
 */

import { stripHtmlExt, pathToId } from '../utils/normalize.mjs';
import { inferDomain, normalizeReqRef } from '../utils/schemas.mjs';

/**
 * 从文档提取所有 REQ 条目
 * @param {Document} document
 * @returns {Array<{id,htmlId,status,domain,title,xrefs,criteria}>}
 */
export function extractReqs(document) {
  return [...document.querySelectorAll('section[data-req], div[data-req], article[data-req]')].map(el => ({
    id: el.getAttribute('data-req'),
    htmlId: el.getAttribute('id'),
    status: el.getAttribute('data-req-status') || 'unknown',
    domain: el.getAttribute('data-req-domain') || inferDomain(el.getAttribute('data-req')),
    priority: el.getAttribute('data-req-priority') || '',
    title: headingText(el),
    xrefs: extractXrefsFrom(el),
    criteria: [...el.querySelectorAll('[data-criterion]')].map((c, i) => ({
      id: c.getAttribute('data-criterion-id') || `${el.getAttribute('id')}-c${i + 1}`,
      text: c.textContent.trim(),
    })),
  }));
}

/**
 * 从文档提取所有数据实体（支持 data-entity section 和 data-entity-table）
 * @param {Document} document
 * @returns {Array<{id,name,fields,xrefs,tableName,indexes,jsonSchemas}>}
 */
export function extractEntities(document) {
  return [...document.querySelectorAll('[data-entity]')].map(el => {
    const name = el.getAttribute('data-entity');
    const fields = extractEntityFields(el);
    const indexes = extractIndexStrategy(el);
    const jsonSchemas = extractJsonSchemas(el);
    return {
      id: el.getAttribute('id') || `data-${name.toLowerCase()}`,
      name,
      title: headingText(el),
      fields,
      indexes,
      jsonSchemas,
      xrefs: extractXrefsFrom(el),
    };
  });
}

/**
 * 从实体区域提取字段（支持 data-entity-table 和 data-field div 两种格式）
 */
function extractEntityFields(el) {
  const tableRows = el.querySelectorAll('table[data-entity-table] tr[data-field]');
  if (tableRows.length > 0) {
    return [...tableRows].map(tr => ({
      name: tr.getAttribute('data-field'),
      type: tr.getAttribute('data-type') || '',
      constraints: tr.getAttribute('data-constraints') || '',
      required: tr.getAttribute('data-required') === 'true',
    }));
  }
  return [...el.querySelectorAll('[data-field]')].map(f => ({
    name: f.getAttribute('data-field'),
    type: f.getAttribute('data-type') || '',
    constraints: f.getAttribute('data-constraints') || '',
    required: f.getAttribute('data-required') === 'true',
  }));
}

/**
 * 从实体区域提取索引策略
 * @returns {Array<{name,fields,type,unique,condition}>}
 */
function extractIndexStrategy(el) {
  const section = el.querySelector('[data-index-strategy]');
  if (!section) return [];
  return [...section.querySelectorAll('table[data-index-table] tr')].slice(1)
    .filter(tr => tr.querySelector('td'))
    .map(tr => {
      const cells = [...tr.querySelectorAll('td')].map(c => c.textContent.trim());
      return { name: cells[0] || '', fields: cells[1] || '', type: cells[2] || '', unique: cells[3] === '是', condition: cells[4] || '' };
    });
}

/**
 * 从实体区域提取 JSON Schema 定义
 * @returns {Array<{field,schema}>}
 */
function extractJsonSchemas(el) {
  const schemas = [];
  for (const section of el.querySelectorAll('[data-json-schema]')) {
    const field = section.getAttribute('data-json-schema');
    for (const s of section.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const parsed = JSON.parse(s.textContent);
        if (parsed.schema) schemas.push({ field, schema: parsed.schema });
      } catch { /* skip */ }
    }
  }
  return schemas;
}

/**
 * 从文档提取所有 API 端点（支持 data-api section 和 data-api-table 紧凑列表）
 * @param {Document} document
 * @returns {Array<{id,method,path,title,xrefs,params,response}>}
 */
export function extractApis(document) {
  return [...document.querySelectorAll('section[data-api], div[data-api], tr[data-api]')].filter(el => {
    if (!el.matches('tr[data-api]')) return true;
    const apiDef = el.getAttribute('data-api') || '';
    return /`\/[^`]+`|\/api\/|\/v\d\/| \/[^ ]+/.test(apiDef);
  }).map(el => {
    const apiDef = el.getAttribute('data-api');
    const [method, path] = parseApiDef(apiDef);
    const params = extractApiParams(el);
    const response = extractApiResponse(el);
    return {
      id: el.getAttribute('id') || `api-${method}-${pathToId(path)}`,
      method,
      path,
      title: headingText(el),
      xrefs: extractXrefsFrom(el),
      params,
      response,
    };
  });
}

/**
 * 从 API 端点区域提取请求参数（支持 data-api-params table 和 data-param div）
 * @returns {Array<{name,type,required,description}>}
 */
function extractApiParams(el) {
  const tableRows = el.querySelectorAll('table[data-api-params] tr[data-param]');
  if (tableRows.length > 0) {
    return [...tableRows].map(tr => ({
      name: tr.getAttribute('data-param'),
      type: tr.getAttribute('data-type') || '',
      required: tr.getAttribute('data-required') === 'true',
      description: tr.getAttribute('data-desc') || '',
    }));
  }
  return [...el.querySelectorAll('[data-param]')].map(p => ({
    name: p.getAttribute('data-param'),
    type: p.getAttribute('data-type') || '',
    required: p.getAttribute('data-required') === 'true',
    description: '',
  }));
}

/**
 * 从 API 端点区域提取响应定义（JSON-LD）
 */
function extractApiResponse(el) {
  for (const s of el.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const parsed = JSON.parse(s.textContent);
      if (parsed['@type'] === 'ApiResponse') return parsed;
    } catch { /* skip */ }
  }
  return null;
}

/**
 * 从文档提取所有测试条目
 * @param {Document} document
 * @returns {Array<{id,reqRef,title,categories}>}
 */
export function extractTests(document) {
  return [...document.querySelectorAll('[data-test]')].map(el => ({
    id: el.getAttribute('id'),
    testId: el.getAttribute('data-test'),
    reqRef: el.getAttribute('data-req-ref') || el.getAttribute('data-req') || '',
    title: headingText(el),
    categories: (el.getAttribute('data-test-categories') || '').split(',').filter(Boolean),
    xrefs: extractXrefsFrom(el),
  }));
}

/**
 * 从文档提取所有状态机
 * @param {Document} document
 * @returns {Array<{id,name,title,definition}>}
 */
export function extractStateMachines(document) {
  return [...document.querySelectorAll('[data-state-machine]')].map(el => {
    const definition = extractStateMachineJsonLd(el);
    return {
      id: el.getAttribute('id') || `sm-${el.getAttribute('data-state-machine')}`,
      name: el.getAttribute('data-state-machine'),
      title: headingText(el),
      definition,
    };
  });
}

/**
 * 从文档提取所有设计产物
 * @param {Document} document
 * @returns {Array<{id,type,title}>}
 */
export function extractArtifacts(document) {
  return [...document.querySelectorAll('[data-artifact-type]')].map(el => ({
    id: el.getAttribute('id'),
    type: el.getAttribute('data-artifact-type'),
    title: headingText(el),
  }));
}

/**
 * 从文档提取所有章节
 * @param {Document} document
 * @returns {Array<{id,section,title,depth}>}
 */
export function extractSections(document) {
  return [...document.querySelectorAll('section[id]')].map(el => ({
    id: el.getAttribute('id'),
    section: el.getAttribute('data-section') || '',
    title: headingText(el),
    depth: sectionDepth(el),
  }));
}

/**
 * 从文档提取所有交叉引用
 * @param {Document} document
 * @returns {Array<{href,type,xrefId,text,sourceId}>}
 */
export function extractXrefs(document) {
  return [...document.querySelectorAll('a[data-xref-type]')].map(a => ({
    href: a.getAttribute('href'),
    type: a.getAttribute('data-xref-type'),
    xrefId: a.getAttribute('data-xref-id') || '',
    text: a.textContent.trim(),
    sourceId: closestId(a),
  }));
}

/**
 * 从文档提取依赖声明
 * @param {Document} document
 * @returns {Array<{href}>}
 */
export function extractDependencies(document) {
  return [...document.querySelectorAll('link[rel="spec:depends"]')].map(el => ({
    href: el.getAttribute('href'),
  }));
}

/**
 * 从文档提取元数据
 * @param {Document} document
 * @returns {Object}
 */
export function extractMeta(document) {
  const metas = {};
  for (const el of document.querySelectorAll('meta[name^="spec-"]')) {
    const key = el.getAttribute('name').replace('spec-', '');
    metas[key] = el.getAttribute('content');
  }
  return metas;
}

/**
 * 从文档提取所有 JSON-LD
 * @param {Document} document
 * @returns {Array<Object>}
 */
export function extractJsonLd(document) {
  const results = [];
  for (const el of document.querySelectorAll('script[type="application/ld+json"]')) {
    try { results.push(JSON.parse(el.textContent)); }
    catch { /* skip malformed */ }
  }
  return results;
}

// --- 内部工具函数 ---

function extractXrefsFrom(el) {
  return [...el.querySelectorAll('a[data-xref-type]')].map(a => ({
    href: a.getAttribute('href'),
    type: a.getAttribute('data-xref-type'),
    text: a.textContent.trim(),
  }));
}

function extractStateMachineJsonLd(el) {
  for (const s of el.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const parsed = JSON.parse(s.textContent);
      if ((parsed['@type'] === 'StateMachine' || parsed['@type'] === 'stateDiagram') &&
          parsed.states && parsed.transitions) return parsed;
      if (!parsed['@type'] && parsed.states && parsed.transitions) return parsed;
    } catch { /* skip */ }
  }
  return null;
}

function headingText(el) {
  const h = el.querySelector('h1, h2, h3, h4, h5, h6');
  return h ? h.textContent.trim() : '';
}

function closestId(el) {
  let current = el.parentElement;
  let fallbackId = '';
  while (current) {
    const dataReq = current.getAttribute('data-req');
    if (dataReq) return dataReq;
    if (!fallbackId) {
      const id = current.getAttribute('id');
      if (id) fallbackId = id;
    }
    current = current.parentElement;
  }
  return fallbackId;
}

function sectionDepth(el) {
  let depth = 0;
  let current = el.parentElement;
  while (current) {
    if (current.tagName === 'SECTION') depth++;
    current = current.parentElement;
  }
  return depth;
}

function parseApiDef(apiDef) {
  const raw = apiDef.replace(/`/g, '');
  const parts = raw.split(' ');
  if (parts.length >= 2) return [parts[0].toUpperCase(), parts.slice(1).join(' ')];
  return ['GET', raw];
}

/**
 * 提取子文件关系（从 JSON-LD children 字段和 meta spec-subfile）
 * @param {Document} document
 * @returns {{parent:string|null, children:string[], isSubfile:boolean}}
 */
export function extractSubfileInfo(document, filePath, specDir) {
  const subfileMeta = document.querySelector('meta[name="spec-subfile"]');
  const specFileMeta = document.querySelector('meta[name="spec-file"]');
  const fileName = specFileMeta?.getAttribute('content') || '';

  // Detect subfile: file is in a subdirectory of specDir (not directly in SPEC root)
  let isSubfile = !!subfileMeta;
  if (!isSubfile && specDir && filePath) {
    const rel = filePath.slice(specDir.length + 1);
    isSubfile = rel.includes('/');
  }

  let parent = null;
  let children = [];

  for (const el of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const parsed = JSON.parse(el.textContent);
      if (parsed.parent) parent = parsed.parent;
      if (parsed.children) children = parsed.children.map(c => typeof c === 'string' ? c : c.id || c['@id'] || String(c));
    } catch { /* skip */ }
  }

  // Infer parent from breadcrumb: try ../ then ./ patterns, take last match (direct parent)
  if (isSubfile && !parent) {
    const breadcrumbLinks = [...document.querySelectorAll('[data-spec-breadcrumb] a')];
    for (let i = breadcrumbLinks.length - 1; i >= 0; i--) {
      const href = breadcrumbLinks[i].getAttribute('href') || '';
      let match = href.match(/\.\.\/([0-9]+-[A-Z][-A-Z]*)\.html/);
      if (!match) match = href.match(/\.\/([0-9]+-[A-Z][-A-Z]*)\.html/);
      if (match && match[1] !== '00-INDEX') { parent = match[1]; break; }
    }
    // Fallback 1: infer from fileName prefix (e.g., "03.02-xxx" → "03-PROCESS")
    if (!parent && fileName && /^\d{2}\.\d{2}/.test(fileName)) {
      const mainNum = fileName.split('.')[0];
      for (const link of breadcrumbLinks) {
        const href = link.getAttribute('href') || '';
        const m = href.match(new RegExp(`/${mainNum}-[A-Z][-A-Z]*\\.html`));
        if (m) { parent = m[0].replace(/^\//, '').replace(/\.html$/, ''); break; }
      }
    }
  }

  // Fallback 2: infer from directory name using spec-file meta of sibling main file
  // (e.g., "requirements/" → "10-REQUIREMENTS", "reference/" → "README")
  if (isSubfile && !parent && specDir && filePath) {
    const rel = filePath.slice(specDir.length + 1);
    const dirName = rel.split('/')[0];
    // Try to find a main file matching this directory semantic
    const breadcrumbLinks = [...document.querySelectorAll('[data-spec-breadcrumb] a')];
    for (const link of breadcrumbLinks) {
      const href = link.getAttribute('href') || '';
      const match = href.match(/\.\.\/([0-9]+-[A-Z][-A-Z]*|README)\.html/);
      if (match) { parent = match[1]; break; }
    }
  }

  return { parent, children, isSubfile };
}

/**
 * 提取 API 域分组（data-api-group 属性）
 * @param {Document} document
 * @returns {Array<{group:string, endpoints:Array}>}
 */
export function extractApiGroups(document) {
  return [...document.querySelectorAll('[data-api-group]')].map(el => ({
    group: el.getAttribute('data-api-group'),
    endpoints: [...el.querySelectorAll('[data-api]')].map(api => {
      const apiDef = api.getAttribute('data-api');
      const [method, path] = parseApiDef(apiDef);
      return { id: api.getAttribute('id'), method, path, title: headingText(api) };
    }),
  }));
}

/**
 * 提取实体域分组（从 data-entity 或目录索引表推断）
 * @param {Document} document
 * @returns {Array<{domain:string, entities:Array}>}
 */
export function extractEntityDomains(document) {
  const groups = [];
  for (const el of document.querySelectorAll('[data-entity]')) {
    const name = el.getAttribute('data-entity');
    const domain = inferDomainFromEntityName(name);
    let group = groups.find(g => g.domain === domain);
    if (!group) {
      group = { domain, entities: [] };
      groups.push(group);
    }
    group.entities.push({ id: el.getAttribute('id'), name, title: headingText(el) });
  }
  return groups;
}

function inferDomainFromEntityName(name) {
  const domainMap = {
    Users: 'auth', Roles: 'auth', Permissions: 'auth',
    Subscriptions: 'subscription', Plans: 'subscription', Pricing: 'subscription',
    Orders: 'billing', Payments: 'billing', Invoices: 'billing',
    Logs: 'operations', AuditLogs: 'operations', Metrics: 'operations',
  };
  return domainMap[name] || 'core';
}

/**
 * 从文档提取所有算法定义
 */
export function extractAlgorithms(document) {
  return [...document.querySelectorAll('[data-algorithm]')].map(el => {
    const definition = extractAlgorithmJsonLd(el);
    return {
      id: el.getAttribute('id') || `alg-${el.getAttribute('data-algorithm')}`,
      name: el.getAttribute('data-algorithm'),
      title: headingText(el),
      type: el.getAttribute('data-algorithm-type') || '',
      complexity: el.getAttribute('data-algorithm-complexity') || '',
      space: el.getAttribute('data-algorithm-space') || '',
      definition,
      xrefs: extractXrefsFrom(el),
    };
  });
}

function extractAlgorithmJsonLd(el) {
  for (const s of el.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const parsed = JSON.parse(s.textContent);
      if (parsed['@type'] === 'Algorithm') return parsed;
    } catch { /* skip */ }
  }
  return null;
}

/**
 * 从文档提取所有管道定义
 */
export function extractPipelines(document) {
  return [...document.querySelectorAll('[data-pipeline]')].map(el => {
    const definition = extractPipelineJsonLd(el);
    return {
      id: el.getAttribute('id') || `pipe-${el.getAttribute('data-pipeline')}`,
      name: el.getAttribute('data-pipeline'),
      title: headingText(el),
      type: el.getAttribute('data-pipeline-type') || '',
      definition,
      xrefs: extractXrefsFrom(el),
    };
  });
}

function extractPipelineJsonLd(el) {
  for (const s of el.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const parsed = JSON.parse(s.textContent);
      if (parsed['@type'] === 'Pipeline') return parsed;
    } catch { /* skip */ }
  }
  return null;
}

/**
 * 从文档提取所有集成定义
 */
export function extractIntegrations(document) {
  return [...document.querySelectorAll('[data-integration]')].map(el => {
    const definition = extractIntegrationJsonLd(el);
    return {
      id: el.getAttribute('id') || `int-${el.getAttribute('data-integration')}`,
      name: el.getAttribute('data-integration'),
      title: headingText(el),
      protocol: el.getAttribute('data-integration-protocol') || '',
      auth: el.getAttribute('data-integration-auth') || '',
      definition,
      xrefs: extractXrefsFrom(el),
    };
  });
}

function extractIntegrationJsonLd(el) {
  for (const s of el.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const parsed = JSON.parse(s.textContent);
      if (parsed['@type'] === 'Integration') return parsed;
    } catch { /* skip */ }
  }
  return null;
}

/**
 * 从文档提取所有时序约束
 */
export function extractTimings(document) {
  return [...document.querySelectorAll('[data-timing]')].map(el => {
    const definition = extractTimingJsonLd(el);
    return {
      id: el.getAttribute('id') || `tmg-${el.getAttribute('data-timing')}`,
      name: el.getAttribute('data-timing'),
      title: headingText(el),
      constraint: el.getAttribute('data-timing-constraint') || '',
      definition,
      xrefs: extractXrefsFrom(el),
    };
  });
}

function extractTimingJsonLd(el) {
  for (const s of el.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const parsed = JSON.parse(s.textContent);
      if (parsed['@type'] === 'TimingConstraint') return parsed;
    } catch { /* skip */ }
  }
  return null;
}

/**
 * 从文档提取所有非功能需求
 */
export function extractNfrs(document) {
  return [...document.querySelectorAll('[data-nfr]')].map(el => {
    const definition = extractNfrJsonLd(el);
    return {
      id: el.getAttribute('id') || `nfr-${el.getAttribute('data-nfr')}`,
      name: el.getAttribute('data-nfr'),
      title: headingText(el),
      category: el.getAttribute('data-nfr-category') || '',
      definition,
      xrefs: extractXrefsFrom(el),
    };
  });
}

function extractNfrJsonLd(el) {
  for (const s of el.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const parsed = JSON.parse(s.textContent);
      if (parsed['@type'] === 'NFR') return parsed;
    } catch { /* skip */ }
  }
  return null;
}

/**
 * 构建全局索引（支持主文件/子文件关系）
 * @param {Array} docs - parseSpecFile 返回的文档数组
 * @param {string} dirPath
 * @returns {{docs, idMap, fileMap, dirPath, childrenMap, subfileMap}}
 */
export function buildIndex(docs, dirPath) {
  const idMap = new Map();
  const fileMap = new Map();
  const childrenMap = new Map();
  const subfileMap = new Map();

  const entityByName = new Map();
  const apiByKey = new Map();
  const apiByPath = new Map();
  const testByReqId = new Map();
  const xrefsBySource = new Map();
  const xrefsByTarget = new Map();
  const entityNameSet = new Set();
  const smNameSet = new Set();
  const reqMap = new Map();
  const reqsByDomain = new Map();
  const algorithmByName = new Map();
  const pipelineByName = new Map();
  const integrationByName = new Map();
  const timingByName = new Map();
  const nfrByName = new Map();
  const algorithmNameSet = new Set();
  const pipelineNameSet = new Set();
  const integrationNameSet = new Set();
  const timingNameSet = new Set();
  const nfrNameSet = new Set();

  const pathToFileName = new Map();
  for (const doc of docs) {
    fileMap.set(doc.fileName, doc);
    pathToFileName.set(doc.fileName, doc.fileName);
    pathToFileName.set(doc.fileName + '.html', doc.fileName);
    if (doc.filePath) {
      const relPath = doc.filePath.replace(dirPath + '/', '');
      pathToFileName.set(relPath, doc.fileName);
      pathToFileName.set(stripHtmlExt(relPath), doc.fileName);
    }
  }

  function resolveChildRef(c) {
    const normalized = stripHtmlExt(c);
    if (pathToFileName.has(c)) return pathToFileName.get(c);
    if (pathToFileName.has(normalized)) return pathToFileName.get(normalized);
    const baseName = normalized.includes('/') ? normalized.split('/').pop() : normalized;
    if (pathToFileName.has(baseName)) return pathToFileName.get(baseName);
    return baseName;
  }

  // Phase 1: Collect all children from parent JSON-LD declarations
  for (const doc of docs) {
    if (doc.subfileInfo?.children?.length > 0) {
      const resolved = doc.subfileInfo.children.map(resolveChildRef);
      childrenMap.set(doc.fileName, resolved);
    }
  }

  // Phase 2: Register subfiles (infer parent if not declared)
  for (const doc of docs) {
    if (doc.subfileInfo?.isSubfile && doc.subfileInfo.parent) {
      subfileMap.set(doc.fileName, doc.subfileInfo.parent);
      const existing = childrenMap.get(doc.subfileInfo.parent) || [];
      if (!existing.includes(doc.fileName)) {
        existing.push(doc.fileName);
        childrenMap.set(doc.subfileInfo.parent, existing);
      }
    }
  }

  // Phase 3: Single-pass build all lookup tables
  for (const doc of docs) {
    // ID index
    for (const collection of [doc.sections, doc.reqs, doc.stateMachines, doc.artifacts]) {
      for (const item of collection) {
        if (item.id || item.htmlId) {
          idMap.set(item.id || item.htmlId, { file: doc.fileName, ...item });
        }
      }
    }

    // Entity lookup
    for (const e of (doc.entities || [])) {
      entityByName.set(e.name, { entity: e, doc });
      entityNameSet.add(e.name);
    }

    // API lookup
    for (const a of (doc.apis || [])) {
      const key = `${a.method} ${a.path}`;
      apiByKey.set(key, { api: a, doc });
      apiByPath.set(a.path, { api: a, doc });
    }

    // Test → REQ mapping
    for (const t of (doc.tests || [])) {
      const refs = normalizeReqRef(t.reqRef);
      for (const ref of refs) {
        if (!testByReqId.has(ref)) testByReqId.set(ref, []);
        testByReqId.get(ref).push({ test: t, doc });
      }
    }

    // Xref source + target index
    for (const xr of (doc.xrefs || [])) {
      if (xr.sourceId) {
        if (!xrefsBySource.has(xr.sourceId)) xrefsBySource.set(xr.sourceId, []);
        xrefsBySource.get(xr.sourceId).push(xr);
      }
      const target = xr.xrefId || xr.href;
      if (target) {
        let cleanTarget = target.replace(/^#/, '');
        // Strip file path: "dir/file.html#anchor" → "anchor"
        const hashIdx = cleanTarget.indexOf('#');
        if (hashIdx >= 0) cleanTarget = cleanTarget.slice(hashIdx + 1);
        if (cleanTarget) {
          if (!xrefsByTarget.has(cleanTarget)) xrefsByTarget.set(cleanTarget, []);
          xrefsByTarget.get(cleanTarget).push(xr);
        }
      }
    }

    // SM name set
    for (const sm of (doc.stateMachines || [])) smNameSet.add(sm.name);

    // Algorithm/Pipeline/Integration/Timing/NFR lookups
    for (const alg of (doc.algorithms || [])) {
      algorithmByName.set(alg.name, { item: alg, doc });
      algorithmNameSet.add(alg.name);
    }
    for (const pipe of (doc.pipelines || [])) {
      pipelineByName.set(pipe.name, { item: pipe, doc });
      pipelineNameSet.add(pipe.name);
    }
    for (const integ of (doc.integrations || [])) {
      integrationByName.set(integ.name, { item: integ, doc });
      integrationNameSet.add(integ.name);
    }
    for (const tm of (doc.timings || [])) {
      timingByName.set(tm.name, { item: tm, doc });
      timingNameSet.add(tm.name);
    }
    for (const nfr of (doc.nfrs || [])) {
      nfrByName.set(nfr.name, { item: nfr, doc });
      nfrNameSet.add(nfr.name);
    }

    // REQ map + domain grouping
    for (const r of (doc.reqs || [])) {
      reqMap.set(r.id, r);
      const domain = r.domain || 'unknown';
      if (!reqsByDomain.has(domain)) reqsByDomain.set(domain, []);
      reqsByDomain.get(domain).push({ req: r, doc });
    }
  }

  // Phase 4: Flattened arrays + docPrimaryDomain
  const allReqs = [];
  const allEntities = [];
  const allApis = [];
  const allTests = [];
  const allStateMachines = [];
  const allAlgorithms = [];
  const allPipelines = [];
  const allIntegrations = [];
  const allTimings = [];
  const allNfrs = [];
  const docPrimaryDomain = new Map();
  for (const doc of docs) {
    let domainCount = new Map();
    for (const r of (doc.reqs || [])) {
      allReqs.push(r);
      const d = r.domain || 'unknown';
      domainCount.set(d, (domainCount.get(d) || 0) + 1);
    }
    if (domainCount.size > 0) {
      let best = '', bestCount = 0;
      for (const [d, c] of domainCount) { if (c > bestCount) { best = d; bestCount = c; } }
      docPrimaryDomain.set(doc.fileName, best);
    }
    for (const e of (doc.entities || [])) allEntities.push(e);
    for (const a of (doc.apis || [])) allApis.push(a);
    for (const t of (doc.tests || [])) allTests.push(t);
    for (const sm of (doc.stateMachines || [])) allStateMachines.push(sm);
    for (const alg of (doc.algorithms || [])) allAlgorithms.push(alg);
    for (const pipe of (doc.pipelines || [])) allPipelines.push(pipe);
    for (const integ of (doc.integrations || [])) allIntegrations.push(integ);
    for (const tm of (doc.timings || [])) allTimings.push(tm);
    for (const nfr of (doc.nfrs || [])) allNfrs.push(nfr);
  }

  return {
    docs, idMap, fileMap, dirPath, childrenMap, subfileMap,
    entityByName, apiByKey, apiByPath, testByReqId, xrefsBySource, xrefsByTarget,
    entityNameSet, smNameSet, reqMap, reqsByDomain,
    algorithmByName, pipelineByName, integrationByName, timingByName, nfrByName,
    algorithmNameSet, pipelineNameSet, integrationNameSet, timingNameSet, nfrNameSet,
    allReqs, allEntities, allApis, allTests, allStateMachines,
    allAlgorithms, allPipelines, allIntegrations, allTimings, allNfrs,
    docPrimaryDomain,
  };
}
