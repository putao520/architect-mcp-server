/**
 * ID 引用完整性校验器
 *
 * 利用 parseSpecDir 提取的结构化数据，对所有 ID 引用做精确校验。
 * 纯 Set/Map 查找，零正则零截断。
 *
 * 规则：
 *   1. test.reqRef → 必须指向存在的 REQ ID
 *   2. xref type=req → text 必须包含存在的 REQ ID
 *   3. xref type=entity → text 必须匹配存在的 entity name
 *   4. xref type=api → href 必须匹配存在的 API id 或 path
 *   5. xref type=statemachine → text 必须匹配存在的 SM name
 *   6. xref type=test → text 必须匹配存在的 testId
 *   7. SM transition.from → 必须在 states 中
 *   8. SM transition.to → 必须在 states 中
 *   9. SM initialState → 必须在 states 中
 *  10. REQ ID 格式 → 必须匹配 REQ-{DOMAIN}-{N}
 */

import { ReqIdSchema, extractReqId, normalizeReqRef } from '../utils/schemas.mjs';

export function validateStateMachine(sm, fileName) {
  const errors = [];
  if (!sm.definition || !sm.definition.states) return errors;
  const stateSet = new Set(sm.definition.states);

  if (sm.definition.initialState && !stateSet.has(sm.definition.initialState)) {
    errors.push({ file: fileName, message: `SM "${sm.name}" initialState "${sm.definition.initialState}" not in states [${sm.definition.states.join(', ')}]` });
  }
  for (const t of (sm.definition.transitions || [])) {
    if (t.from && !stateSet.has(t.from)) {
      errors.push({ file: fileName, message: `SM "${sm.name}" transition from="${t.from}" not in states [${sm.definition.states.join(', ')}]` });
    }
    if (t.to && !stateSet.has(t.to)) {
      errors.push({ file: fileName, message: `SM "${sm.name}" transition to="${t.to}" not in states [${sm.definition.states.join(', ')}]` });
    }
  }
  return errors;
}

export function validateReferences(index) {
  const errors = [];
  const warnings = [];

  // === 使用 index 预计算表 ===

  const allReqIds = index.reqMap ? new Set(index.reqMap.keys()) : new Set();
  const allEntityNames = index.entityNameSet || new Set();
  const allSmNames = index.smNameSet || new Set();

  const allApiIds = new Set();
  const allApiPaths = new Set();
  const allTestIds = new Set();

  // 始终从 docs 收集实际 API ID（元素 id 属性值）
  for (const doc of index.docs) {
    for (const a of doc.apis) {
      allApiIds.add(a.id);
      allApiPaths.add(`${a.method} ${a.path}`);
      allApiPaths.add(a.path);
    }
    for (const t of doc.tests) allTestIds.add(t.testId);
  }

  // 补充预计算表中的派生 ID
  if (index.apiByKey) {
    for (const key of index.apiByKey.keys()) {
      const [method, ...rest] = key.split(' ');
      const path = rest.join(' ');
      allApiIds.add(`api-${method.toLowerCase()}-${path.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase()}`);
      allApiPaths.add(key);
      allApiPaths.add(path);
    }
  }

  if (index.testByReqId) {
    for (const [, entries] of index.testByReqId) {
      for (const { test } of entries) allTestIds.add(test.testId);
    }
  }

  // 辅助：生成"有效值提示"（最多 5 个）
  function hint(set, maxLen = 10) {
    const items = [...set];
    if (items.length <= maxLen) return items.join(', ');
    return items.slice(0, maxLen).join(', ') + `, ... (${items.length} total)`;
  }

  // === 规则 10: REQ ID 格式 ===

  for (const doc of index.docs) {
    for (const req of doc.reqs) {
      if (!ReqIdSchema.safeParse(req.id).success) {
        warnings.push({
          file: doc.fileName,
          message: `REQ ID "${req.id}" does not match format REQ-{DOMAIN}-{N}`,
        });
      }
    }
  }

  // === 规则 1: test.reqRef ===

  for (const doc of index.docs) {
    for (const test of doc.tests) {
      if (!test.reqRef) continue;
      const refs = normalizeReqRef(test.reqRef);
      for (const ref of refs) {
        if (!allReqIds.has(ref)) {
          errors.push({
            file: doc.fileName,
            message: `test "${test.testId}" reqRef "${ref}" not found (valid: ${hint(allReqIds)})`,
          });
        }
      }
    }
  }

  // === 规则 2-6: xref type-based 引用 ===

  for (const doc of index.docs) {
    for (const xref of doc.xrefs) {
      const type = xref.type;
      if (!type) continue;

      switch (type) {
        case 'req': {
          // 规则 2: xref type=req → text 中提取 REQ ID
          const reqId = extractReqId(xref.text);
          if (reqId && !allReqIds.has(reqId)) {
            errors.push({
              file: doc.fileName,
              message: `xref type=req "${reqId}" not found (from #${xref.sourceId}, valid: ${hint(allReqIds)})`,
            });
          }
          break;
        }
        case 'entity': {
          // 规则 3: xref type=entity → text 匹配 entity name
          if (xref.text && !allEntityNames.has(xref.text)) {
            errors.push({
              file: doc.fileName,
              message: `xref type=entity "${xref.text}" not found (from #${xref.sourceId}, valid: ${hint(allEntityNames)})`,
            });
          }
          break;
        }
        case 'api': {
          // 规则 4: xref type=api → href 匹配 API id 或 path
          if (xref.href) {
            // Strip file path: "system/file.html#anchor" → "anchor"
            let cleaned = xref.href.replace(/^#/, '');
            const hashIdx = cleaned.indexOf('#');
            if (hashIdx >= 0) cleaned = cleaned.slice(hashIdx + 1);
            if (!allApiIds.has(cleaned) && !allApiPaths.has(cleaned)) {
              errors.push({
                file: doc.fileName,
                message: `xref type=api "${cleaned}" not found (from #${xref.sourceId}, valid: ${hint(allApiPaths)})`,
              });
            }
          }
          break;
        }
        case 'statemachine':
        case 'state-machine': {
          // 规则 5: xref type=statemachine → text 匹配 SM name
          if (xref.text && !allSmNames.has(xref.text)) {
            errors.push({
              file: doc.fileName,
              message: `xref type=statemachine "${xref.text}" not found (from #${xref.sourceId}, valid: ${hint(allSmNames)})`,
            });
          }
          break;
        }
        case 'test': {
          // 规则 6: xref type=test → text 匹配 testId
          if (xref.text && !allTestIds.has(xref.text)) {
            errors.push({
              file: doc.fileName,
              message: `xref type=test "${xref.text}" not found (from #${xref.sourceId}, valid: ${hint(allTestIds)})`,
            });
          }
          break;
        }
      }
    }
  }

  // === 规则 7-9: State Machine 内部一致性 ===

  for (const doc of index.docs) {
    for (const sm of doc.stateMachines) {
      const smErrors = validateStateMachine(sm, doc.fileName);
      errors.push(...smErrors);
    }
  }

  // === 规则 11-15: 新维度 xref 引用完整性 ===

  const algorithmNameSet = index.algorithmNameSet || new Set();
  const pipelineNameSet = index.pipelineNameSet || new Set();
  const integrationNameSet = index.integrationNameSet || new Set();
  const timingNameSet = index.timingNameSet || new Set();
  const nfrNameSet = index.nfrNameSet || new Set();

  for (const doc of index.docs) {
    for (const xref of doc.xrefs) {
      const type = xref.type;
      if (!type) continue;

      switch (type) {
        case 'algorithm': {
          if (xref.text && !algorithmNameSet.has(xref.text)) {
            errors.push({
              file: doc.fileName,
              message: `xref type=algorithm "${xref.text}" not found (from #${xref.sourceId}, valid: ${hint(algorithmNameSet)})`,
            });
          }
          break;
        }
        case 'pipeline': {
          if (xref.text && !pipelineNameSet.has(xref.text)) {
            errors.push({
              file: doc.fileName,
              message: `xref type=pipeline "${xref.text}" not found (from #${xref.sourceId}, valid: ${hint(pipelineNameSet)})`,
            });
          }
          break;
        }
        case 'integration': {
          if (xref.text && !integrationNameSet.has(xref.text)) {
            errors.push({
              file: doc.fileName,
              message: `xref type=integration "${xref.text}" not found (from #${xref.sourceId}, valid: ${hint(integrationNameSet)})`,
            });
          }
          break;
        }
        case 'timing': {
          if (xref.text && !timingNameSet.has(xref.text)) {
            errors.push({
              file: doc.fileName,
              message: `xref type=timing "${xref.text}" not found (from #${xref.sourceId}, valid: ${hint(timingNameSet)})`,
            });
          }
          break;
        }
        case 'nfr': {
          if (xref.text && !nfrNameSet.has(xref.text)) {
            errors.push({
              file: doc.fileName,
              message: `xref type=nfr "${xref.text}" not found (from #${xref.sourceId}, valid: ${hint(nfrNameSet)})`,
            });
          }
          break;
        }
      }
    }
  }

  return { errors, warnings };
}
