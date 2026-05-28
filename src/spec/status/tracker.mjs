import { getOrBuildTestsByReqId } from '../audit/coverage-data.mjs';

export function trackStatus(index) {
  const byDomain = new Map();
  const byStatus = new Map();
  let total = 0;

  if (index.reqsByDomain) {
    for (const [domain, entries] of index.reqsByDomain) {
      const reqs = entries.map(e => e.req);
      byDomain.set(domain, reqs);
      total += reqs.length;
      for (const req of reqs) {
        const status = req.status || 'unknown';
        byStatus.set(status, (byStatus.get(status) || 0) + 1);
      }
    }
  } else {
    for (const doc of index.docs) {
      for (const req of doc.reqs) {
        total++;
        const domain = req.domain || 'unknown';
        if (!byDomain.has(domain)) byDomain.set(domain, []);
        byDomain.get(domain).push(req);
        const status = req.status || 'unknown';
        byStatus.set(status, (byStatus.get(status) || 0) + 1);
      }
    }
  }

  return { byDomain, byStatus, total };
}

export function findStale(index) {
  const stale = [];
  const testByReqId = getOrBuildTestsByReqId(index);

  for (const doc of index.docs) {
    for (const req of doc.reqs) {
      if (req.status === 'implemented') {
        if (!testByReqId.has(req.id)) stale.push({ file: doc.fileName, req: req.id, reason: 'no test link' });
      }
      if (req.status === 'draft' || req.status === 'designed') {
        stale.push({ file: doc.fileName, req: req.id, reason: `status=${req.status}` });
      }
    }
  }
  return stale;
}
