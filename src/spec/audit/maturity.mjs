/**
 * SPEC 成熟度审计 + REQ 覆盖度分析
 *
 * 四层模型：SPEC 定义 → 设计文档 → 代码实现 → 测试覆盖
 *
 * auditMaturity:  按域生成四层成熟度矩阵 + 加权成熟度指数
 * auditReqCoverage: 逐 REQ 构建链接明细（实体/API/测试/状态机）
 * grepSync: 在源码目录中批量检索 REQ ID 引用
 */

import { extractReqIdsFromText } from '../utils/schemas.mjs';
import { collectAllReqs, collectAllTests, getOrBuildTestsByReqId, getOrBuildEntityNameSet, getOrBuildSmNameSet, getOrBuildReqMap } from './coverage-data.mjs';
import { isUnitTest, isIntegrationTest, isSystemTest, isAcceptanceTest } from './test-quality.mjs';
import { execSync } from 'child_process';

// ============================================================
// Code 层：批量 grep（一次扫描提取所有 REQ ID 引用）
// ============================================================

/**
 * 批量 grep — 从源码目录中提取所有匹配 REQ-XXX-NNN 模式的行
 * 一次调用覆盖全部 REQ IDs，避免逐 ID grep 的 N×30s 问题
 *
 * @param {string} dir - 源码目录路径
 * @returns {Map<string, string[]>} REQ ID → 文件路径列表
 */
export function grepSync(dir) {
  const result = new Map();
  try {
    // 一次 grep 提取所有 REQ-XXX-NNN 引用，输出 "文件:匹配行"
    const raw = execSync(
      `grep -rn --include='*.rs' --include='*.ts' --include='*.js' --include='*.go' --include='*.py' --include='*.java' --include='*.c' --include='*.cpp' --include='*.jsx' --include='*.tsx' --include='*.mjs' -E 'REQ-[A-Z]+(-[A-Z]+)*-[0-9]+' '${dir}'`,
      { timeout: 60000, encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 },
    );
    // 解析 "path/to/file.rs:42:... REQ-CORE-001 ..." → REQ-CORE-001 → Set<file>
    const fileMap = new Map();
    for (const line of raw.split('\n')) {
      const colonIdx = line.indexOf(':');
      if (colonIdx < 0) continue;
      const filePath = line.slice(0, colonIdx);
      const matches = extractReqIdsFromText(line);
      if (!matches) continue;
      for (const reqId of matches) {
        if (!fileMap.has(reqId)) fileMap.set(reqId, new Set());
        fileMap.get(reqId).add(filePath);
      }
    }
    for (const [reqId, files] of fileMap) {
      result.set(reqId, [...files]);
    }
  } catch {
    // grep 返回非零表示无匹配
  }
  return result;
}

// ============================================================
// 数据收集
// ============================================================

// ============================================================
// Design 层判定
// ============================================================

/**
 * REQ 满足 Design 层的条件（任一即可）：
 * 1. 有 criteria 且非空
 * 2. 有 xref 指向 entity / api / statemachine
 * 3. status 为 "designed" / "implemented" / "tested"
 * 4. idMap 中有反向引用的 entity/api/statemachine
 */
function hasDesignLayer(req, index) {
  if (req.criteria && req.criteria.length > 0) return true;

  const status = (req.status || '').toLowerCase();
  if (status === 'designed' || status === 'implemented' || status === 'tested') return true;

  if (req.xrefs && req.xrefs.length > 0) {
    for (const xref of req.xrefs) {
      const t = (xref.type || '').toLowerCase();
      if (t === 'entity' || t === 'api' || t === 'statemachine' || t === 'state-machine') return true;
    }
  }

  const xrefsBySource = index.xrefsBySource;
  if (!xrefsBySource) return false;

  const reqHtmlId = req.htmlId || req.id;
  const sourceXrefs = xrefsBySource.get(reqHtmlId) || xrefsBySource.get(req.id) || [];
  if (sourceXrefs.length > 0) return true;

  // Reverse lookup: who targets this REQ?
  const xrefsByTarget = index.xrefsByTarget;
  if (xrefsByTarget) {
    const targeting = xrefsByTarget.get(reqHtmlId) || xrefsByTarget.get(req.id) || [];
    for (const xref of targeting) {
      const t = (xref.type || '').toLowerCase();
      if (t === 'entity' || t === 'api' || t === 'statemachine' || t === 'state-machine') return true;
    }
  }

  return false;
}

// ============================================================
// Test 层判定
// ============================================================

function hasTestLayer(req, testsByReq, xrefsByTarget) {
  if (testsByReq.has(req.id)) return true;
  const reqHtmlId = req.htmlId || req.id;

  if (xrefsByTarget) {
    const targeting = xrefsByTarget.get(reqHtmlId) || xrefsByTarget.get(req.id) || [];
    for (const xref of targeting) {
      if ((xref.type || '').toLowerCase() === 'test') return true;
    }
  }
  return false;
}

// ============================================================
// 成熟度审计 — 四层矩阵 + 加权成熟度指数
// ============================================================

/**
 * @param {object} index - parseSpecDir 输出
 * @param {object} options
 * @param {string} [options.domain] - 过滤特定 domain
 * @param {string} [options.sourceDir] - 源码目录（Code 层需要）
 * @param {Map<string, string[]>} [options.codeRefs] - 预计算的 REQ ID → files 映射（跳过 grep）
 * @returns {object}
 */
export function auditMaturity(index, { domain, sourceDir, codeRefs } = {}) {
  const allReqEntries = collectAllReqs(index);
  const allTests = collectAllTests(index);
  const testsByReq = getOrBuildTestsByReqId(index);

  // Code 层：批量 grep 一次，或使用预计算结果
  let codeMap = codeRefs || null;
  if (!codeMap && sourceDir) {
    codeMap = grepSync(sourceDir);
  }

  // 按 domain 分组
  const domainMap = new Map();
  for (const entry of allReqEntries) {
    const d = entry.req.domain || 'unknown';
    if (domain && d !== domain) continue;
    if (!domainMap.has(d)) domainMap.set(d, []);
    domainMap.get(d).push(entry);
  }

  // 逐 domain 计算
  const domains = [];
  const totals = { spec: 0, design: 0, code: 0, test: 0, codeUnknown: 0 };
  const gaps = { spec: [], design: [], code: [], test: [] };
  const codeMismatches = []; // SPEC 有但 Code 用缩写的 REQ

  for (const [d, entries] of domainMap) {
    let specCount = 0, designCount = 0, codeCount = 0, testCount = 0;

    for (const { req } of entries) {
      specCount++;

      // Design layer
      if (hasDesignLayer(req, index)) {
        designCount++;
      } else {
        gaps.design.push(req.id);
      }

      // Code layer — 精确匹配 REQ ID
      if (codeMap) {
        if (codeMap.has(req.id)) {
          codeCount++;
        } else {
          gaps.code.push(req.id);
        }
      } else {
        totals.codeUnknown++;
      }

      // Test layer
      if (hasTestLayer(req, testsByReq, index.xrefsByTarget)) {
        testCount++;
      } else {
        gaps.test.push(req.id);
      }
    }

    totals.spec += specCount;
    totals.design += designCount;
    totals.code += codeCount;
    totals.test += testCount;

    const designRate = specCount > 0 ? designCount / specCount : 0;
    const codeRate = specCount > 0 && codeMap ? codeCount / specCount : null;
    const testRate = specCount > 0 ? testCount / specCount : 0;

    // 成熟度指数：三层加权 (Design 20% + Code 40% + Test 40%)
    // 无 Code 层数据时：(Design 30% + Test 70%)
    let maturity;
    if (codeMap) {
      maturity = designRate * 0.2 + (codeRate || 0) * 0.4 + testRate * 0.4;
    } else {
      maturity = designRate * 0.3 + testRate * 0.7;
    }

    domains.push({
      domain: d,
      specCount,
      designCount,
      codeCount: codeMap ? codeCount : null,
      testCount,
      designRate,
      codeRate,
      testRate,
      maturity,
    });
  }

  // 汇总
  const totalDesignRate = totals.spec > 0 ? totals.design / totals.spec : 0;
  const totalCodeRate = codeMap && totals.spec > 0 ? totals.code / totals.spec : null;
  const totalTestRate = totals.spec > 0 ? totals.test / totals.spec : 0;

  let totalMaturity;
  if (codeMap) {
    totalMaturity = totalDesignRate * 0.2 + (totalCodeRate || 0) * 0.4 + totalTestRate * 0.4;
  } else {
    totalMaturity = totalDesignRate * 0.3 + totalTestRate * 0.7;
  }

  // Test-level coverage breakdown
  const testLevelCounts = { unit: 0, integration: 0, system: 0, acceptance: 0 };
  const entityNameSet = getOrBuildEntityNameSet(index);
  const smNameSet = getOrBuildSmNameSet(index);
  const reqMapLocal = getOrBuildReqMap(index);

  for (const { test } of allTests) {
    if (isUnitTest(test)) testLevelCounts.unit++;
    if (isIntegrationTest(test, entityNameSet)) testLevelCounts.integration++;
    if (isSystemTest(test, smNameSet)) testLevelCounts.system++;
    if (isAcceptanceTest(test, reqMapLocal)) testLevelCounts.acceptance++;
  }

  return {
    domains,
    totals: {
      specCount: totals.spec,
      designCount: totals.design,
      codeCount: codeMap ? totals.code : null,
      testCount: totals.test,
      testLevels: testLevelCounts,
      codeUnknown: codeMap ? 0 : totals.codeUnknown,
      designRate: totalDesignRate,
      codeRate: totalCodeRate,
      testRate: totalTestRate,
      maturity: totalMaturity,
    },
    gaps,
    codeMismatches,
    timestamp: new Date().toISOString(),
  };
}

// ============================================================
// REQ 覆盖度分析 — 逐 REQ 构建链接明细
// ============================================================

/**
 * @param {object} index - parseSpecDir 输出
 * @param {object} options
 * @param {string} [options.domain] - 过滤特定 domain
 * @param {string} [options.sourceDir] - 源码目录（Code 层需要）
 * @param {Map<string, string[]>} [options.codeRefs] - 预计算的 REQ ID → files 映射
 * @returns {object}
 */
export function auditReqCoverage(index, { domain, sourceDir, codeRefs } = {}) {
  const allReqEntries = collectAllReqs(index);
  const allTests = collectAllTests(index);
  const testsByReq = getOrBuildTestsByReqId(index);

  let codeMap = codeRefs || null;
  if (!codeMap && sourceDir) codeMap = grepSync(sourceDir);

  const reqs = [];
  const summary = {
    total: 0,
    withCriteria: 0,
    withEntity: 0,
    withApi: 0,
    withTest: 0,
    withCode: 0,
  };

  for (const { req, fileName } of allReqEntries) {
    if (domain && (req.domain || 'unknown') !== domain) continue;

    const linkedEntities = [];
    const linkedApis = [];
    const linkedStateMachines = [];
    const linkedTests = [];
    let codeFiles = null;

    // 1. REQ 自身 xrefs
    if (req.xrefs && req.xrefs.length > 0) {
      for (const xref of req.xrefs) {
        const t = xref.type || '';
        if (t === 'entity') linkedEntities.push({ ref: xref.href || xref.text, source: 'req-xref' });
        else if (t === 'api') linkedApis.push({ ref: xref.href || xref.text, source: 'req-xref' });
        else if (t === 'statemachine' || t === 'state-machine') linkedStateMachines.push({ ref: xref.href || xref.text, source: 'req-xref' });
        else if (t === 'test') linkedTests.push({ ref: xref.href || xref.text, source: 'req-xref' });
      }
    }

    // 2. 反向引用扫描
    const reqHtmlId = req.htmlId || req.id;
    for (const doc of index.docs) {
      for (const entity of doc.entities) {
        if (entity.xrefs && entity.xrefs.length > 0) {
          for (const xref of entity.xrefs) {
            if (xref.href === '#' + reqHtmlId || xref.href === '#' + req.id ||
                (xref.text && xref.text.includes(req.id))) {
              linkedEntities.push({ ref: entity.name, file: doc.fileName, source: 'entity-xref' });
              break;
            }
          }
        }
      }
      for (const api of doc.apis) {
        if (api.xrefs && api.xrefs.length > 0) {
          for (const xref of api.xrefs) {
            if (xref.href === '#' + reqHtmlId || xref.href === '#' + req.id ||
                (xref.text && xref.text.includes(req.id))) {
              linkedApis.push({ ref: `${api.method} ${api.path}`, file: doc.fileName, source: 'api-xref' });
              break;
            }
          }
        }
      }
      for (const sm of doc.stateMachines) {
        if (sm.xrefs && sm.xrefs.length > 0) {
          for (const xref of sm.xrefs) {
            if (xref.href === '#' + reqHtmlId || xref.href === '#' + req.id ||
                (xref.text && xref.text.includes(req.id))) {
              linkedStateMachines.push({ ref: sm.name, file: doc.fileName, source: 'sm-xref' });
              break;
            }
          }
        }
      }
      for (const xref of doc.xrefs) {
        if ((xref.href === '#' + reqHtmlId || xref.href === '#' + req.id ||
             (xref.text && xref.text.includes(req.id))) && xref.sourceId) {
          const sourceEntry = index.idMap.get(xref.sourceId);
          if (sourceEntry) {
            const entryType = (sourceEntry.type || '').toLowerCase();
            if (entryType.includes('entity') && !linkedEntities.some(e => e.ref === sourceEntry.name)) {
              linkedEntities.push({ ref: sourceEntry.name, file: doc.fileName, source: 'doc-xref' });
            } else if (entryType.includes('api') && !linkedApis.some(a => a.ref === `${sourceEntry.method} ${sourceEntry.path}`)) {
              linkedApis.push({ ref: `${sourceEntry.method} ${sourceEntry.path}`, file: doc.fileName, source: 'doc-xref' });
            } else if ((entryType.includes('statemachine') || entryType.includes('state-machine')) &&
                       !linkedStateMachines.some(s => s.ref === sourceEntry.name)) {
              linkedStateMachines.push({ ref: sourceEntry.name, file: doc.fileName, source: 'doc-xref' });
            }
          }
        }
      }
    }

    // 3. 测试匹配（使用共享 testsByReq map）
    const matchedTests = testsByReq.get(req.id) || [];
    for (const { test } of matchedTests) {
      linkedTests.push({ testId: test.testId || test.id, title: test.title, categories: test.categories || [] });
    }
    for (const { test, fileName: testFile } of allTests) {
      if (test.reqRef && test.reqRef === req.id) continue;
      if (test.xrefs && test.xrefs.length > 0) {
        for (const xref of test.xrefs) {
          if (xref.href === '#' + reqHtmlId || xref.href === '#' + req.id ||
              (xref.text && xref.text.includes(req.id))) {
            if (!matchedTests.some(m => m.test === test)) {
              linkedTests.push({ testId: test.testId || test.id, title: test.title, file: testFile, categories: test.categories || [] });
            }
            break;
          }
        }
      }
    }

    // 4. Code 匹配（精确 ID）
    if (codeMap) {
      const files = codeMap.get(req.id);
      if (files) codeFiles = files;
    }

    const uniqueEntities = dedupByRef(linkedEntities);
    const uniqueApis = dedupByRef(linkedApis);
    const uniqueSMs = dedupByRef(linkedStateMachines);

    reqs.push({
      id: req.id,
      domain: req.domain || 'unknown',
      status: req.status,
      hasCriteria: !!(req.criteria && req.criteria.length > 0),
      criteriaCount: req.criteria ? req.criteria.length : 0,
      linkedEntities: uniqueEntities,
      linkedApis: uniqueApis,
      linkedTests,
      linkedStateMachines: uniqueSMs,
      codeFiles,
      hasCode: codeFiles ? codeFiles.length > 0 : null,
    });

    summary.total++;
    if (req.criteria && req.criteria.length > 0) summary.withCriteria++;
    if (uniqueEntities.length > 0) summary.withEntity++;
    if (uniqueApis.length > 0) summary.withApi++;
    if (linkedTests.length > 0) summary.withTest++;
    if (codeFiles && codeFiles.length > 0) summary.withCode++;
  }

  return { reqs, summary };
}

function dedupByRef(items) {
  const seen = new Set();
  return items.filter(item => {
    if (seen.has(item.ref)) return false;
    seen.add(item.ref);
    return true;
  });
}
