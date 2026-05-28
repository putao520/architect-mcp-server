import { normalizeReqRef } from '../utils/schemas.mjs';

export function collectAllReqs(index) {
  const all = [];
  for (const doc of index.docs) {
    for (const req of doc.reqs) {
      all.push({ req, fileName: doc.fileName });
    }
  }
  return all;
}

export function collectAllTests(index) {
  const all = [];
  for (const doc of index.docs) {
    for (const test of doc.tests) {
      all.push({ test, fileName: doc.fileName });
    }
  }
  return all;
}

function buildTestsByReqMapInternal(index) {
  const map = new Map();
  for (const doc of index.docs) {
    for (const t of (doc.tests || [])) {
      const refs = normalizeReqRef(t.reqRef);
      for (const ref of refs) {
        if (!map.has(ref)) map.set(ref, []);
        map.get(ref).push({ test: t, doc });
      }
    }
  }
  return map;
}

export function getOrBuildTestsByReqId(index) {
  return index.testByReqId || buildTestsByReqMapInternal(index);
}

export function getOrBuildEntityNameSet(index) {
  return index.entityNameSet || new Set([...(index.entityByName?.keys() || [])]);
}

export function getOrBuildSmNameSet(index) {
  return index.smNameSet || new Set();
}

export function getOrBuildReqMap(index) {
  return index.reqMap || new Map();
}
