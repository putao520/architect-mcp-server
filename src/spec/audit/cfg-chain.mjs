/**
 * CFG Chain Audit — 状态机 CFG 路径可达性 + 数据流追踪 + 链完整性验证
 *
 * Phase 1: SM Graph Build — 从 JSON-LD definition 构建 CFG（states=nodes, transitions=edges）
 * Phase 2: Reachability — BFS 从 initialState 验证所有状态可达
 * Phase 3: Dead State Detection — 不可达状态 + 终端状态 + 孤立状态
 * Phase 4: REQ-SM Binding — REQ 通过 xref 绑定到 SM，验证 REQ 需要的状态路径存在
 * Phase 5: Transition→API Mapping — transition.on 匹配 API endpoint + openapi/validator 约束校验
 * Phase 6: Transition→Test Coverage — REQ 关联测试覆盖 transition 路径
 * Phase 7: Entity Data Flow — Entity 字段在 API params 中的数据流追踪
 * Phase 8: Mermaid CFG — 带颜色标注的 CFG 可视化
 */

import { validateSpecApi, validatePathParamConsistency } from '../openapi/validator.mjs';

/**
 * @param {object} index - parseSpecDir 输出
 * @returns {object}
 */
export function auditCfgChain(index) {
  const { docs } = index;

  // === 全局查找表（复用 buildIndex 预计算） ===

  const entityByName = index.entityByName || new Map();
  const apiByKey = index.apiByKey || new Map();
  const apiByPath = index.apiByPath || new Map();
  const testByReqId = index.testByReqId || new Map();
  const xrefsBySource = index.xrefsBySource || new Map();

  // Pre-build entity field → API index (avoids O(REQs*APIs*fields) in traceDataFlow)
  const allApis = index.allApis || docs.flatMap(d => d.apis);

  // Build API ID lookup from all docs
  const apiById = new Map();
  for (const api of allApis) {
    if (api.id) apiById.set(api.id, api);
  }

  const entityFieldToApis = new Map();
  for (const api of allApis) {
    const method = api.method || 'GET';
    const key = `${method} ${api.path}`;
    for (const p of (api.params || [])) {
      const name = p.name || p;
      if (!entityFieldToApis.has(name)) entityFieldToApis.set(name, []);
      entityFieldToApis.get(name).push({ apiKey: key, method });
    }
  }

  // === Phase 1: Build SM Graphs ===

  const smGraphs = [];
  for (const doc of docs) {
    for (const sm of (doc.stateMachines || [])) {
      if (!sm.definition || !sm.definition.states) continue;
      const graph = buildSmGraph(sm, doc);
      smGraphs.push(graph);
    }
  }

  // === Phase 2+3: Reachability + Dead States ===

  for (const g of smGraphs) {
    analyzeReachability(g);
  }

  // === Phase 4-7: Per-REQ Chain Verification ===

  const lookup = { entityByName, apiByKey, apiByPath, apiById, testByReqId, xrefsBySource, entityFieldToApis };
  const reqResults = [];

  for (const doc of docs) {
    for (const req of (doc.reqs || [])) {
      const chain = verifyReqChain(req, doc, docs, smGraphs, lookup);
      reqResults.push(chain);
    }
  }

  // === Summary ===

  const totalReqs = reqResults.length;
  const completeChains = reqResults.filter(r => r.complete).length;
  const brokenChains = reqResults.filter(r => !r.complete).length;
  const totalSmStates = smGraphs.reduce((s, g) => s + g.states.length, 0);
  const reachableStates = smGraphs.reduce((s, g) => s + g.reachableStates.size, 0);
  const deadStates = smGraphs.reduce((s, g) => s + g.deadStates.length, 0);
  const totalTransitions = smGraphs.reduce((s, g) => s + g.transitions.length, 0);
  const coveredTransitions = smGraphs.reduce((s, g) => s + g.transitions.filter(t => t.apiMatch).length, 0);

  return {
    summary: {
      totalReqs,
      completeChains,
      brokenChains,
      chainRate: totalReqs > 0 ? completeChains / totalReqs : 0,
      smGraphs: smGraphs.length,
      totalSmStates,
      reachableStates,
      deadStates,
      totalTransitions,
      coveredTransitions,
      transitionCoverage: totalTransitions > 0 ? coveredTransitions / totalTransitions : 0,
    },
    smGraphs: smGraphs.map(g => ({
      name: g.name,
      initialState: g.initialState,
      states: g.states,
      reachable: [...g.reachableStates],
      deadStates: g.deadStates,
      transitions: g.transitions.map(t => ({
        from: t.from, to: t.to, on: t.on,
        apiMatch: t.apiMatch, apiKey: t.apiKey,
        apiErrors: t.apiErrors || [],
        testCovered: t.testCovered,
      })),
      mermaidCfg: g.mermaidCfg,
    })),
    reqs: reqResults,
  };
}

// ============================================================
// SM Graph Construction
// ============================================================

function buildSmGraph(sm, doc) {
  const def = sm.definition;
  const initialState = def.initialState || def.states[0];

  const stateSet = new Set(def.states);
  const transitions = (def.transitions || []).map(t => ({
    from: t.from,
    to: t.to,
    on: t.on || '',
    fromValid: stateSet.has(t.from),
    toValid: stateSet.has(t.to),
    apiMatch: null,
    apiKey: null,
    testCovered: false,
  }));

  // adjacency: state → [{transition, target}]
  const adj = new Map();
  for (const t of transitions) {
    if (!adj.has(t.from)) adj.set(t.from, []);
    adj.get(t.from).push(t);
  }

  // reverse adjacency: state → [transition]
  const radj = new Map();
  for (const t of transitions) {
    if (!radj.has(t.to)) radj.set(t.to, []);
    radj.get(t.to).push(t);
  }

  return {
    name: sm.name,
    id: sm.id,
    doc,
    states: [...def.states],
    initialState,
    transitions,
    adj,
    radj,
    reachableStates: new Set(),
    deadStates: [],
    mermaidCfg: null,
  };
}

// ============================================================
// Reachability Analysis (BFS from initialState)
// ============================================================

function analyzeReachability(graph) {
  const { initialState, adj, states } = graph;
  const visited = new Set();
  const queue = [initialState];

  while (queue.length > 0) {
    const cur = queue.shift();
    if (visited.has(cur)) continue;
    visited.add(cur);

    const outEdges = adj.get(cur) || [];
    for (const t of outEdges) {
      if (!visited.has(t.to) && t.toValid) {
        queue.push(t.to);
      }
    }
  }

  graph.reachableStates = visited;

  // Dead states: in states[] but not reachable
  graph.deadStates = states.filter(s => !visited.has(s));

  // Terminal states: reachable but no outgoing transitions (sink states)
  // These are OK (final states), but worth flagging if unexpected
  graph.terminalStates = states.filter(s => {
    if (!visited.has(s)) return false;
    const out = adj.get(s) || [];
    // Only self-loops or no outgoing
    return out.length === 0 || out.every(t => t.to === s);
  });

  // Try to match each transition to API
  matchTransitionsToApi(graph, apiByKey, apiByPath);

  // Generate Mermaid
  graph.mermaidCfg = generateMermaidCfg(graph);
}

// ============================================================
// Phase 5: Transition → API Mapping
// ============================================================

function matchTransitionsToApi(graph, apiByKey, apiByPath) {
  for (const t of graph.transitions) {
    if (!t.on) continue;

    const trigger = t.on.toLowerCase();
    const matched = findApiForTrigger(trigger, apiByKey, apiByPath);
    if (matched) {
      t.apiMatch = true;
      t.apiKey = matched;
      const apiEntry = apiByKey.get(matched);
      if (apiEntry) {
        const validation = validateSpecApi(apiEntry.api);
        if (!validation.valid) {
          t.apiErrors = validation.errors.map(e => `${e.field}: ${e.message}`);
        }
        const pathErrors = validatePathParamConsistency(apiEntry.api);
        if (pathErrors.length > 0) {
          t.apiErrors = [...(t.apiErrors || []), ...pathErrors.map(e => e.message)];
        }
      }
    } else {
      t.apiMatch = false;
    }
  }
}

const ACTION_KEYWORDS = [
  { keywords: ['创建', '新增', '注册', 'submit', 'create', 'add', 'register', 'post'], method: 'POST' },
  { keywords: ['更新', '修改', '编辑', '封禁', '解封', '启用', '禁用', 'update', 'edit', 'ban', 'enable', 'disable', 'put', 'patch'], method: 'PUT' },
  { keywords: ['删除', '移除', 'delete', 'remove'], method: 'DELETE' },
  { keywords: ['查询', '获取', '列表', '搜索', 'search', 'list', 'get', 'fetch'], method: 'GET' },
];

function findApiForTrigger(trigger, apiByKey, apiByPath) {
  const lower = trigger.toLowerCase();
  for (const { keywords, method } of ACTION_KEYWORDS) {
    if (keywords.some(kw => lower.includes(kw))) {
      for (const [path] of apiByPath) {
        const key = `${method} ${path}`;
        if (apiByKey.has(key)) return key;
      }
    }
  }
  return null;
}

// ============================================================
// Mermaid CFG Visualization
// ============================================================

function generateMermaidCfg(graph) {
  const lines = ['stateDiagram-v2'];
  lines.push(`  [*] --> ${graph.initialState}`);

  for (const t of graph.transitions) {
    const label = t.on ? `: ${t.on}` : '';
    const color = t.apiMatch ? '' : ' %% NO-API';
    lines.push(`  ${t.from} --> ${t.to}${label}${color}`);
  }

  // 标注不可达状态
  for (const ds of graph.deadStates) {
    lines.push(`  state "${ds} ☠ UNREACHABLE" as ${ds}_dead`);
  }

  return lines.join('\n');
}

// ============================================================
// Per-REQ Chain Verification
// ============================================================

function verifyReqChain(req, doc, docs, smGraphs, lookup) {
  const { entityByName, apiByKey, apiByPath, testByReqId, xrefsBySource } = lookup;
  const result = {
    reqId: req.id,
    domain: req.domain,
    status: req.status,
    entity: null,
    apis: [],
    stateMachine: null,
    smPath: null,
    tests: [],
    dataFlow: null,
    complete: false,
    breaks: [],
  };

  // --- Entity 绑定 ---
  const entityNames = findLinkedEntities(req, doc, docs, xrefsBySource);
  if (entityNames.length > 0) {
    const firstName = entityNames[0];
    const found = entityByName.get(firstName);
    result.entity = {
      name: firstName,
      found: !!found,
      fieldCount: found ? (found.entity.fields || []).length : 0,
    };
    if (!found) result.breaks.push(`Entity "${firstName}" not found`);

    // --- Data Flow: Entity fields → API params ---
    if (found) {
      result.dataFlow = traceDataFlow(found.entity, lookup.entityFieldToApis);
    }
  } else {
    result.breaks.push('No entity linked to REQ');
  }

  // --- API 绑定 ---
  const apiRefs = findLinkedApis(req, doc, docs, xrefsBySource);
  for (const ref of apiRefs) {
    let cleanRef = ref.replace(/^#/, '');
    const hashIdx = cleanRef.indexOf('#');
    if (hashIdx >= 0) cleanRef = cleanRef.slice(hashIdx + 1);
    const found = lookup.apiByKey.has(ref) || lookup.apiByPath.has(ref) || lookup.apiById.has(cleanRef);
    result.apis.push({ ref, found });
    if (!found) result.breaks.push(`API "${ref}" not found`);
  }
  if (apiRefs.length === 0) {
    result.breaks.push('No API linked to REQ');
  }

  // --- State Machine 绑定 ---
  const smBinding = findReqSmBinding(req, doc, docs, smGraphs, xrefsBySource);
  if (smBinding) {
    result.stateMachine = {
      name: smBinding.graph.name,
      reachable: smBinding.pathAnalysis.reachable,
      targetStates: smBinding.targetStates,
      coveredTransitions: smBinding.coveredTransitions,
      totalTransitions: smBinding.totalTransitions,
    };

    if (smBinding.pathAnalysis.reachable) {
      result.smPath = {
        initialState: smBinding.graph.initialState,
        targetStates: smBinding.targetStates,
        path: smBinding.pathAnalysis.path,
        pathLength: smBinding.pathAnalysis.pathLength,
      };
    } else {
      result.breaks.push(`SM "${smBinding.graph.name}": target state ${smBinding.targetStates.join('/')} unreachable from ${smBinding.graph.initialState}`);
    }

    // SM transition test coverage
    for (const t of smBinding.graph.transitions) {
      if (t.testCovered) continue;
      // Check if any test for this REQ covers this transition
      const tests = testByReqId.get(req.id) || [];
      if (tests.length > 0) {
        t.testCovered = true;
      }
    }
  }

  // --- Test 绑定 ---
  const tests = testByReqId.get(req.id) || [];
  result.tests = tests.map(t => ({
    testId: t.test.testId,
    title: t.test.title || '',
    categories: t.test.categories || [],
  }));
  if (tests.length === 0) {
    result.breaks.push('No test linked to REQ');
  }

  // --- 完整性判断 ---
  const hasEntity = result.entity && result.entity.found;
  const hasApi = result.apis.length > 0 && result.apis.some(a => a.found);
  const hasTest = result.tests.length > 0;
  const smOk = !smBinding || smBinding.pathAnalysis.reachable;
  result.complete = hasEntity && hasApi && hasTest && smOk;

  return result;
}

// ============================================================
// Entity 查找
// ============================================================

function findLinkedEntities(req, doc, docs, xrefsBySource) {
  const names = new Set();
  const reqXrefs = xrefsBySource.get(req.id) || [];
  for (const xr of reqXrefs) {
    if (xr.type === 'entity' && xr.text) names.add(xr.text);
  }
  return [...names];
}

// ============================================================
// API 查找
// ============================================================

function findLinkedApis(req, doc, docs, xrefsBySource) {
  const refs = new Set();
  const reqXrefs = xrefsBySource.get(req.id) || [];
  for (const xr of reqXrefs) {
    if (xr.type === 'api' && xr.href) refs.add(xr.href);
  }
  return [...refs];
}

// ============================================================
// REQ-SM Binding + Path Analysis
// ============================================================

function findReqSmBinding(req, doc, docs, smGraphs, xrefsBySource) {
  const candidates = [];
  const reqXrefs = xrefsBySource.get(req.id) || [];
  for (const xr of reqXrefs) {
    if (xr.type === 'statemachine' || xr.type === 'state-machine') {
      const match = smGraphs.find(g => g.name === xr.text || g.id === xr.xrefId);
      if (match) candidates.push(match);
    }
  }

  // domain 匹配
  if (candidates.length === 0) {
    const domain = (req.domain || '').toLowerCase();
    for (const g of smGraphs) {
      if (g.name.toLowerCase().includes(domain) || domain.includes(g.name.toLowerCase())) {
        candidates.push(g);
      }
    }
  }

  if (candidates.length === 0) return null;

  // 取第一个候选（最强绑定优先）
  const graph = candidates[0];

  // 确定 REQ 的目标状态
  // 从 criteria 中提取状态关键词，或在 transitions 的 on 文本中匹配 REQ id
  const targetStates = findTargetStates(req, graph);

  // BFS 路径验证
  const pathAnalysis = bfsPathAnalysis(graph, targetStates);

  // Transition 覆盖统计
  let coveredTransitions = 0;
  for (const t of graph.transitions) {
    if (t.apiMatch !== false) coveredTransitions++;
  }

  return {
    graph,
    targetStates,
    pathAnalysis,
    coveredTransitions,
    totalTransitions: graph.transitions.length,
  };
}

function findTargetStates(req, graph) {
  const targets = new Set();
  const domain = (req.domain || '').toLowerCase();
  const reqId = req.id.toLowerCase();

  // 从 REQ criteria 中匹配状态名
  for (const criterion of (req.criteria || [])) {
    const text = (criterion.text || criterion).toLowerCase();
    for (const state of graph.states) {
      if (text.includes(state.toLowerCase())) {
        targets.add(state);
      }
    }
  }

  // 从 REQ id 中提取状态关键词
  for (const state of graph.states) {
    if (reqId.includes(state.toLowerCase())) {
      targets.add(state);
    }
  }

  // 如果没有匹配到，检查 transitions.on 是否引用了 REQ
  for (const t of graph.transitions) {
    if (t.on && t.on.toLowerCase().includes(domain)) {
      targets.add(t.to);
    }
  }

  return targets.size > 0 ? [...targets] : graph.states.slice(0, 1);
}

function bfsPathAnalysis(graph, targetStates) {
  const { initialState, adj } = graph;
  const visited = new Map(); // state → parent state
  const queue = [initialState];
  visited.set(initialState, null);

  while (queue.length > 0) {
    const cur = queue.shift();
    const outEdges = adj.get(cur) || [];
    for (const t of outEdges) {
      if (!visited.has(t.to) && t.toValid) {
        visited.set(t.to, cur);
        queue.push(t.to);
      }
    }
  }

  // 检查目标状态是否可达
  const reachableTargets = targetStates.filter(s => visited.has(s));
  const reachable = reachableTargets.length > 0;

  // 回溯最短路径到第一个可达目标
  let path = [];
  let pathLength = 0;
  if (reachable) {
    const target = reachableTargets[0];
    const pathStates = [];
    let cur = target;
    while (cur !== null) {
      pathStates.unshift(cur);
      cur = visited.get(cur);
    }
    path = pathStates;
    pathLength = pathStates.length - 1;
  }

  return { reachable, path, pathLength, visitedStates: visited.size };
}

// ============================================================
// Entity Data Flow Tracing
// ============================================================

function traceDataFlow(entity, entityFieldToApis) {
  const entityFields = (entity.fields || []).map(f => f.name || f);
  const writtenBy = [];
  const readBy = [];
  const seen = new Set();

  for (const field of entityFields) {
    const apis = entityFieldToApis.get(field) || [];
    for (const { apiKey, method } of apis) {
      if (seen.has(apiKey)) continue;
      seen.add(apiKey);
      const entry = { apiKey, overlapFields: entityFields.filter(f => entityFieldToApis.get(f)?.some(a => a.apiKey === apiKey)).length };
      if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
        writtenBy.push(entry);
      } else {
        readBy.push(entry);
      }
    }
  }

  return {
    entity: entity.name,
    fieldCount: entityFields.size,
    writtenByApis: writtenBy.length,
    readByApis: readBy.length,
    totalFlow: writtenBy.length + readBy.length,
  };
}
