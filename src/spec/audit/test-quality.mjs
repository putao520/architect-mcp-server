/**
 * Test Quality Audit — REQ-to-test coverage across four levels.
 *
 * Levels:
 *   Unit        — category contains "unit" OR testId contains "unit"
 *   Integration — category contains "integration"|"api" OR references multiple entities
 *   System      — category contains "system"|"e2e"|"flow" OR references a state machine
 *   Acceptance  — test.reqRef matches a REQ that has criteria
 */

import { collectAllTests, getOrBuildTestsByReqId, getOrBuildEntityNameSet, getOrBuildSmNameSet, getOrBuildReqMap } from './coverage-data.mjs';
import { normalizeReqRef } from '../utils/schemas.mjs';

export function isUnitTest(test) {
  const cats = test.categories || [];
  if (cats.some(c => /\bunit\b/i.test(c))) return true;
  if (/\bunit\b/i.test(test.testId || '')) return true;
  return false;
}

export function isIntegrationTest(test, entityNameSet = new Set()) {
  const cats = test.categories || [];
  if (cats.some(c => /\b(integration|api)\b/i.test(c))) return true;
  const text = [test.title || '', ...cats].join(' ');
  let entityHits = 0;
  for (const name of entityNameSet) {
    if (text.includes(name)) {
      entityHits++;
      if (entityHits >= 2) return true;
    }
  }
  return false;
}

export function isSystemTest(test, smNameSet = new Set()) {
  const cats = test.categories || [];
  if (cats.some(c => /\b(system|e2e|flow)\b/i.test(c))) return true;
  const text = [test.title || '', ...cats].join(' ');
  for (const name of smNameSet) {
    if (text.includes(name)) return true;
  }
  return false;
}

export function isAcceptanceTest(test, reqMap = new Map()) {
  const refs = normalizeReqRef(test.reqRef);
  for (const ref of refs) {
    const req = reqMap.get(ref);
    if (req && req.criteria && req.criteria.length > 0) return true;
  }
  return false;
}

export function auditTestQuality(index, { domain } = {}) {
  const testsByReq = getOrBuildTestsByReqId(index);
  const entityNameSet = getOrBuildEntityNameSet(index);
  const smNameSet = getOrBuildSmNameSet(index);
  const reqMap = getOrBuildReqMap(index);

  // --- process each REQ --------------------------------------------------------
  const reqResults = [];

  for (const doc of index.docs) {
    if (!doc.reqs) continue;
    for (const req of doc.reqs) {
      if (domain && req.domain !== domain) continue;

      const linked = testsByReq.get(req.id) || [];

      const unitTests = [];
      const integrationTests = [];
      const systemTests = [];
      const acceptanceTests = [];

      for (const { test: t } of linked) {
        if (isUnitTest(t)) unitTests.push({ testId: t.testId, title: t.title });
        if (isIntegrationTest(t, entityNameSet)) integrationTests.push({ testId: t.testId, title: t.title });
        if (isSystemTest(t, smNameSet)) systemTests.push({ testId: t.testId, title: t.title });
        if (isAcceptanceTest(t, reqMap)) acceptanceTests.push({ testId: t.testId, title: t.title });
      }

      const coverage = {
        unit: unitTests.length > 0,
        integration: integrationTests.length > 0,
        system: systemTests.length > 0,
        acceptance: acceptanceTests.length > 0,
      };

      const gap = [];
      if (!coverage.unit) gap.push('unit');
      if (!coverage.integration) gap.push('integration');
      if (!coverage.system) gap.push('system');
      if (!coverage.acceptance) gap.push('acceptance');

      reqResults.push({ reqId: req.id, domain: req.domain, unitTests, integrationTests, systemTests, acceptanceTests, coverage, gap });
    }
  }

  // --- summary -----------------------------------------------------------------
  const domainMap = new Map();
  let grandTotal = 0, grandUnit = 0, grandIntegration = 0, grandSystem = 0, grandAcceptance = 0;

  for (const r of reqResults) {
    const d = r.domain || '__unknown__';
    if (!domainMap.has(d)) domainMap.set(d, { total: 0, unit: 0, integration: 0, system: 0, acceptance: 0 });
    const dm = domainMap.get(d);
    dm.total++;
    if (r.coverage.unit) dm.unit++;
    if (r.coverage.integration) dm.integration++;
    if (r.coverage.system) dm.system++;
    if (r.coverage.acceptance) dm.acceptance++;
    grandTotal++;
    if (r.coverage.unit) grandUnit++;
    if (r.coverage.integration) grandIntegration++;
    if (r.coverage.system) grandSystem++;
    if (r.coverage.acceptance) grandAcceptance++;
  }

  const byDomain = {};
  for (const [d, dm] of domainMap) {
    byDomain[d] = {
      total: dm.total,
      unit: dm.total > 0 ? dm.unit / dm.total : 0,
      integration: dm.total > 0 ? dm.integration / dm.total : 0,
      system: dm.total > 0 ? dm.system / dm.total : 0,
      acceptance: dm.total > 0 ? dm.acceptance / dm.total : 0,
    };
  }

  const summary = {
    totalReqs: grandTotal,
    overall: {
      unit: grandTotal > 0 ? grandUnit / grandTotal : 0,
      integration: grandTotal > 0 ? grandIntegration / grandTotal : 0,
      system: grandTotal > 0 ? grandSystem / grandTotal : 0,
      acceptance: grandTotal > 0 ? grandAcceptance / grandTotal : 0,
    },
    byDomain,
  };

  return { reqs: reqResults, summary };
}
