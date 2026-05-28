/**
 * Architecture Entropy Audit — quantitative measures of SPEC structural quality.
 *
 * Metrics:
 *   1. Domain Shannon Entropy  — H = -Sum(p_i * log2(p_i))
 *   2. Coupling                — cross-file xref density
 *   3. Cohesion                — within-domain xref density
 *   4. Depth Entropy           — section nesting depth distribution entropy
 *   5. GAP Entropy             — coverage std dev across domains (optional)
 *
 * Pure computation, no external dependencies.
 */

/**
 * @param {object} index - parseSpecDir output
 * @param {object} [maturityResult] - optional output from auditTestQuality or similar
 * @returns {object}
 */
export function auditArchitectureEntropy(index, maturityResult) {
  const { docs } = index;

  // --- 1. Domain Shannon Entropy -----------------------------------------------

  const domainCounts = new Map();
  let totalReqs = 0;
  for (const doc of docs) {
    if (doc.reqs) {
      for (const r of doc.reqs) {
        const d = r.domain || '__unknown__';
        domainCounts.set(d, (domainCounts.get(d) || 0) + 1);
        totalReqs++;
      }
    }
  }

  const numDomains = domainCounts.size;
  const domainEntropyValue = shannonEntropy(domainCounts, totalReqs);
  const domainEntropyMax = numDomains > 1 ? Math.log2(numDomains) : 0;
  const domainEntropyNormalized = domainEntropyMax > 0 ? domainEntropyValue / domainEntropyMax : 0;

  // --- 2. Coupling & 3. Cohesion -----------------------------------------------

  const docPrimaryDomain = index.docPrimaryDomain || new Map();
  const idMap = index.idMap || new Map();

  let totalXrefs = 0;
  let crossFileXrefs = 0;
  let withinDomainXrefs = 0;

  for (const doc of docs) {
    if (!doc.xrefs) continue;
    const sourceDomain = docPrimaryDomain.get(doc.fileName) || '__unknown__';

    for (const xr of doc.xrefs) {
      totalXrefs++;
      const targetId = xr.xrefId || xr.href;

      // Cross-file check via idMap O(1)
      const idEntry = targetId ? idMap.get(targetId) : null;
      if (!idEntry || idEntry.file !== doc.fileName) {
        crossFileXrefs++;
      }

      // Within-domain check via idMap O(1)
      const targetDomain = idEntry
        ? (docPrimaryDomain.get(idEntry.file) || '__unknown__')
        : '__unknown__';
      if (sourceDomain === targetDomain) {
        withinDomainXrefs++;
      }
    }
  }

  const couplingValue = totalXrefs > 0 ? crossFileXrefs / totalXrefs : 0;
  const cohesionValue = totalXrefs > 0 ? withinDomainXrefs / totalXrefs : 0;

  // --- 4. Depth Entropy --------------------------------------------------------

  const depthCounts = new Map();
  let totalSections = 0;
  for (const doc of docs) {
    if (doc.sections) {
      for (const s of doc.sections) {
        const d = s.depth || 0;
        depthCounts.set(d, (depthCounts.get(d) || 0) + 1);
        totalSections++;
      }
    }
  }

  const depthEntropyValue = shannonEntropy(depthCounts, totalSections);
  const depthEntropyMax = depthCounts.size > 1 ? Math.log2(depthCounts.size) : 0;

  const depthDistribution = {};
  for (const [depth, count] of depthCounts) {
    depthDistribution[depth] = totalSections > 0 ? count / totalSections : 0;
  }

  // --- 5. GAP Entropy (optional) -----------------------------------------------

  let gapEntropyValue = 0;
  let domainRates = null;

  // Support both auditTestQuality format (summary.byDomain) and auditMaturity format (domains[])
  if (maturityResult && maturityResult.summary && maturityResult.summary.byDomain) {
    domainRates = {};
    const rates = [];
    for (const [domain, data] of Object.entries(maturityResult.summary.byDomain)) {
      const avg = (data.unit + data.integration + data.system + data.acceptance) / 4;
      domainRates[domain] = avg;
      rates.push(avg);
    }
    gapEntropyValue = standardDeviation(rates);
  } else if (maturityResult && maturityResult.domains) {
    domainRates = {};
    const rates = [];
    for (const d of maturityResult.domains) {
      domainRates[d.domain] = d.testRate;
      rates.push(d.testRate);
    }
    gapEntropyValue = standardDeviation(rates);
  }

  // --- Overall score -----------------------------------------------------------
  // Weighted average: domain(0.25) + cohesion(0.25) + depth(0.20) + (1-coupling)(0.15) + (1-gapNorm)(0.15)
  // Higher = better
  const gapNorm = domainRates
    ? Math.min(gapEntropyValue / 0.5, 1) // normalize: 0.5 std dev → 1
    : 0.5; // neutral when no maturity data

  const overall =
    domainEntropyNormalized * 0.25 +
    cohesionValue * 0.25 +
    (depthEntropyMax > 0 ? (depthEntropyValue / depthEntropyMax) : 1) * 0.20 +
    (1 - couplingValue) * 0.15 +
    (1 - gapNorm) * 0.15;

  return {
    domainEntropy: {
      value: domainEntropyValue,
      max: domainEntropyMax,
      normalized: domainEntropyNormalized,
    },
    coupling: {
      value: couplingValue,
      crossFile: crossFileXrefs,
      total: totalXrefs,
    },
    cohesion: {
      value: cohesionValue,
      withinDomain: withinDomainXrefs,
      total: totalXrefs,
    },
    depthEntropy: {
      value: depthEntropyValue,
      max: depthEntropyMax,
      distribution: depthDistribution,
    },
    gapEntropy: {
      value: gapEntropyValue,
      domainRates,
    },
    overall,
  };
}

// --- helpers -------------------------------------------------------------------

function shannonEntropy(counts, total) {
  if (total === 0) return 0;
  let h = 0;
  for (const count of counts.values()) {
    if (count === 0) continue;
    const p = count / total;
    h -= p * Math.log2(p);
  }
  return h;
}

function standardDeviation(values) {
  if (values.length === 0) return 0;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}


