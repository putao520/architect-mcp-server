/**
 * SPEC Audit — 确定性成熟度审计入口
 *
 * 6 个审计模式：maturity / req_coverage / test_quality / cfg_chain / dfs_connectivity / architecture_entropy
 * MCP 工具注册：registerSpecAuditTools(server)
 * CLI 入口：runAudit(dir, mode, options)
 */

import { z } from 'zod';
import { parseSpecDir } from '../parse/html-parser.mjs';
import { auditMaturity, auditReqCoverage } from './maturity.mjs';
import { auditTestQuality } from './test-quality.mjs';
import { auditCfgChain } from './cfg-chain.mjs';
import { auditDfsConnectivity } from './dfs.mjs';
import { auditArchitectureEntropy } from './entropy.mjs';

const AUDIT_MODES = [
  'maturity',
  'req_coverage',
  'test_quality',
  'cfg_chain',
  'dfs_connectivity',
  'architecture_entropy',
  'coverage',
];

/**
 * 运行指定模式的审计
 * @param {string} dir - SPEC 目录
 * @param {string} mode - 审计模式
 * @param {object} [options]
 * @param {string} [options.sourceDir] - 源码目录
 * @param {string} [options.domain] - 按 domain 过滤
 * @param {string} [options.format] - 输出格式: 'report' | 'json'
 * @returns {object} 审计结果
 */
export function runAudit(dir, mode, options = {}) {
  const index = parseSpecDir(dir);

  switch (mode) {
    case 'maturity':
      return formatResult(mode, auditMaturity(index, { domain: options.domain, sourceDir: options.sourceDir }), options.format);

    case 'req_coverage':
      return formatResult(mode, auditReqCoverage(index, { domain: options.domain }), options.format);

    case 'test_quality':
      return formatResult(mode, auditTestQuality(index, { domain: options.domain }), options.format);

    case 'cfg_chain':
      return formatResult(mode, auditCfgChain(index), options.format);

    case 'dfs_connectivity':
      return formatResult(mode, auditDfsConnectivity(index), options.format);

    case 'architecture_entropy': {
      const maturityResult = auditMaturity(index, { domain: options.domain, sourceDir: options.sourceDir });
      return formatResult(mode, auditArchitectureEntropy(index, maturityResult), options.format);
    }

    case 'coverage': {
      const maturityResult = auditMaturity(index, { domain: options.domain, sourceDir: options.sourceDir });
      const reqCoverageResult = auditReqCoverage(index, { domain: options.domain });
      const testQualityResult = auditTestQuality(index, { domain: options.domain });
      if (options.format === 'json') {
        return { mode, format: 'json', data: { maturity: maturityResult, req_coverage: reqCoverageResult, test_quality: testQualityResult } };
      }
      const parts = [];
      parts.push(formatMaturityReport(maturityResult));
      parts.push('\n' + formatReqCoverageReport(reqCoverageResult));
      parts.push('\n' + formatTestQualityReport(testQualityResult));
      return { mode, format: 'report', text: parts.join('\n') };
    }

    default:
      throw new Error(`Unknown audit mode: ${mode}. Available: ${AUDIT_MODES.join(', ')}`);
  }
}

/**
 * 格式化审计结果
 */
function formatResult(mode, result, format = 'report') {
  if (format === 'json') {
    return { mode, format: 'json', data: result };
  }

  const formatters = {
    maturity: formatMaturityReport,
    req_coverage: formatReqCoverageReport,
    test_quality: formatTestQualityReport,
    cfg_chain: formatCfgChainReport,
    dfs_connectivity: formatDfsReport,
    architecture_entropy: formatEntropyReport,
  };

  const formatter = formatters[mode];
  const text = formatter ? formatter(result) : JSON.stringify(result, null, 2);
  return { mode, format: 'report', text, data: result };
}

// === 报告格式化器 ===

function formatMaturityReport(result) {
  const lines = [];
  const t = result.totals;

  lines.push('=== SPEC 确定性成熟度报告 ===');
  lines.push('');

  // 摘要指标（对标用户例子格式）
  lines.push(`REQ 总数: ${t.specCount}`);
  lines.push(`设计覆盖率: ${(t.designRate * 100).toFixed(1)}% — ${t.designCount}/${t.specCount} 个 REQ 有完整设计定义`);
  if (t.codeCount != null) {
    lines.push(`实现率: ${(t.codeRate * 100).toFixed(1)}% — ${t.codeCount}/${t.specCount} 个 REQ 在源码中有引用`);
  } else {
    lines.push('实现率: N/A — 未提供源码目录 (--source-dir)');
  }
  lines.push(`测试覆盖率: ${(t.testRate * 100).toFixed(1)}% — ${t.testCount}/${t.specCount} 个 REQ 有测试覆盖`);
  lines.push(`成熟度指数: ${(t.maturity * 100).toFixed(1)}%`);
  lines.push('');

  // 按域矩阵（成熟度降序）
  const sorted = [...result.domains].sort((a, b) => b.maturity - a.maturity);

  const hdr = pad('Domain', 18) + '|' + pad('SPEC', 5) + '|' + pad('Design', 7) + '|' + pad('Code', 5) + '|' + pad('Test', 5) + '| 成熟度';
  lines.push(hdr);
  lines.push('-'.repeat(hdr.length + 4));

  for (const d of sorted) {
    const code = d.codeCount != null ? String(d.codeCount) : '-';
    const mat = (d.maturity * 100).toFixed(1) + '%';
    lines.push(pad(d.domain, 18) + '|' + pad(String(d.specCount), 5) + '|' + pct(d.designRate) + '|' + pad(code, 5) + '|' + pad(String(d.testCount), 5) + '| ' + mat);
  }

  lines.push('-'.repeat(hdr.length + 4));
  const tCode = t.codeCount != null ? String(t.codeCount) : '-';
  lines.push(pad('TOTAL', 18) + '|' + pad(String(t.specCount), 5) + '|' + pct(t.designRate) + '|' + pad(tCode, 5) + '|' + pad(String(t.testCount), 5) + '| ' + (t.maturity * 100).toFixed(1) + '%');

  // TOP 域 & GAP 域
  lines.push('');
  const top = sorted.filter(d => d.specCount >= 5).slice(0, 5);
  if (top.length > 0) {
    lines.push('--- 最成熟模块 (TOP 5, REQ>=5) ---');
    for (const d of top) {
      lines.push(`  ${d.domain} ${(d.maturity * 100).toFixed(1)}% — ${d.specCount} 个 REQ 中 ${d.testCount} 个有测试`);
    }
  }

  const bottom = sorted.filter(d => d.specCount >= 3).reverse().slice(0, 5);
  if (bottom.length > 0) {
    lines.push('');
    lines.push('--- 最不成熟模块 (BOTTOM 5, REQ>=3) ---');
    for (const d of bottom) {
      lines.push(`  ${d.domain} ${(d.maturity * 100).toFixed(1)}% — ${d.specCount} 个 REQ 中仅 ${d.testCount} 个有测试`);
    }
  }

  // GAP 清单
  lines.push('');
  if (result.gaps.test.length > 0) {
    lines.push(`--- 测试 GAP (${result.gaps.test.length} 个 REQ 无测试) ---`);
    lines.push(result.gaps.test.join(', '));
  }
  if (result.gaps.code.length > 0) {
    lines.push(`--- 实现 GAP (${result.gaps.code.length} 个 REQ 在源码中未引用) ---`);
    lines.push(result.gaps.code.join(', '));
  }
  if (result.gaps.design.length > 0) {
    lines.push(`--- 设计 GAP (${result.gaps.design.length} 个 REQ 无设计定义) ---`);
    lines.push(result.gaps.design.join(', '));
  }

  lines.push('');
  lines.push(`成熟度公式: Design×${t.codeCount != null ? '0.2' : '0.3'} + Code×${t.codeCount != null ? '0.4' : 'N/A'} + Test×${t.codeCount != null ? '0.4' : '0.7'}`);
  lines.push(`Timestamp: ${result.timestamp}`);
  return lines.join('\n');
}

function formatReqCoverageReport(result) {
  const lines = [];
  lines.push('=== REQ Coverage Report ===');
  lines.push(`Total: ${result.summary.total} | Criteria: ${result.summary.withCriteria} | Entity: ${result.summary.withEntity} | API: ${result.summary.withApi} | Test: ${result.summary.withTest}`);
  lines.push('');

  for (const r of result.reqs) {
    const entity = r.linkedEntities.length > 0 ? r.linkedEntities.map(e => e.ref).join(', ') : '-';
    const api = r.linkedApis.length > 0 ? r.linkedApis.map(a => a.ref).join(', ') : '-';
    const test = r.linkedTests.length > 0 ? r.linkedTests.map(t => t.testId || t.title).join(', ') : '-';
    lines.push(`${r.id} | ${r.status || '?'} | Entity: ${entity} | API: ${api} | Test: ${test}`);
  }

  return lines.join('\n');
}

function formatTestQualityReport(result) {
  const lines = [];
  lines.push('=== Test Quality Report ===');

  const s = result.summary || {};
  lines.push(`Total REQs: ${s.totalReqs || 0}`);
  lines.push('');

  if (s.overall) {
    lines.push('--- Overall Coverage ---');
    for (const [level, rate] of Object.entries(s.overall)) {
      lines.push(`  ${level}: ${(rate * 100).toFixed(1)}%`);
    }
  }

  if (s.byDomain && Object.keys(s.byDomain).length > 0) {
    lines.push('');
    lines.push('--- Per-Domain Coverage ---');
    const hdr = pad('Domain', 16) + '|' + pad('Unit', 8) + '|' + pad('Integ', 8) + '|' + pad('System', 8) + '|' + pad('Accept', 8);
    lines.push(hdr);
    lines.push('-'.repeat(hdr.length + 4));
    for (const [domain, rates] of Object.entries(s.byDomain)) {
      lines.push(pad(domain, 16) + '|' + pct(rates.unit) + '|' + pct(rates.integration) + '|' + pct(rates.system) + '|' + pct(rates.acceptance));
    }
  }

  const reqsWithGaps = (result.reqs || []).filter(r => r.gap && r.gap.length > 0);
  if (reqsWithGaps.length > 0) {
    lines.push('');
    lines.push(`--- REQs Missing Test Levels (${reqsWithGaps.length}) ---`);
    for (const r of reqsWithGaps) {
      lines.push(`  ${r.reqId}: missing ${r.gap.join(', ')}`);
    }
  }

  return lines.join('\n');
}

function formatCfgChainReport(result) {
  const lines = [];
  const s = result.summary || {};
  lines.push('=== CFG Chain Report ===');
  lines.push('');
  lines.push(`REQs: ${s.totalReqs || 0} | Complete: ${s.completeChains || 0} | Broken: ${s.brokenChains || 0} | Chain Rate: ${((s.chainRate || 0) * 100).toFixed(1)}%`);
  lines.push(`SM Graphs: ${s.smGraphs || 0} | States: ${s.totalSmStates || 0} (Reachable: ${s.reachableStates || 0}, Dead: ${s.deadStates || 0})`);
  lines.push(`Transitions: ${s.totalTransitions || 0} | API-Covered: ${s.coveredTransitions || 0} (${((s.transitionCoverage || 0) * 100).toFixed(1)}%)`);

  // SM Graph Detail
  if (result.smGraphs && result.smGraphs.length > 0) {
    lines.push('');
    lines.push('--- State Machine Graphs ---');
    for (const g of result.smGraphs) {
      lines.push('');
      lines.push(`  [SM] ${g.name} (initial: ${g.initialState})`);
      lines.push(`    States: ${g.states.join(', ')}`);
      if (g.deadStates && g.deadStates.length > 0) {
        lines.push(`    DEAD STATES: ${g.deadStates.join(', ')}`);
      }
      for (const t of (g.transitions || [])) {
        const apiFlag = t.apiMatch ? 'API:Y' : 'API:N';
        const testFlag = t.testCovered ? 'TEST:Y' : 'TEST:N';
        lines.push(`    ${t.from} -> ${t.to} (${apiFlag} ${testFlag}): ${t.on || '?'}`);
      }
      if (g.mermaidCfg) {
        lines.push('    ```mermaid');
        for (const l of g.mermaidCfg.split('\n')) lines.push(`    ${l}`);
        lines.push('    ```');
      }
    }
  }

  // REQ Chain Detail (top 30 broken)
  const brokenReqs = (result.reqs || []).filter(r => !r.complete);
  if (brokenReqs.length > 0) {
    lines.push('');
    lines.push(`--- Broken Chains (${brokenReqs.length}) ---`);
    for (const r of brokenReqs) {
      const entity = r.entity ? (r.entity.found ? r.entity.name : `${r.entity.name}(MISSING)`) : '-';
      const apiCount = r.apis ? r.apis.filter(a => a.found).length : 0;
      const apiTotal = r.apis ? r.apis.length : 0;
      const testCount = r.tests ? r.tests.length : 0;
      const sm = r.stateMachine ? `${r.stateMachine.name}${r.stateMachine.reachable ? '' : '(UNREACHABLE)'}` : '-';
      lines.push(`  [BROKEN] ${r.reqId}: Entity=${entity} API=${apiCount}/${apiTotal} SM=${sm} Test=${testCount}`);
      for (const b of (r.breaks || [])) {
        lines.push(`    BREAK: ${b}`);
      }
    }
  }

  // Data Flow summary
  const reqsWithFlow = (result.reqs || []).filter(r => r.dataFlow && r.dataFlow.totalFlow > 0);
  if (reqsWithFlow.length > 0) {
    lines.push('');
    lines.push(`--- Data Flow (${reqsWithFlow.length} REQs with entity→API trace) ---`);
    for (const r of reqsWithFlow) {
      const df = r.dataFlow;
      lines.push(`  ${r.reqId}: ${df.entity}(${df.fieldCount}f) → write:${df.writtenByApis} read:${df.readByApis}`);
    }
  }

  return lines.join('\n');
}

function formatDfsReport(result) {
  const lines = [];
  lines.push('=== DFS Connectivity Report ===');
  lines.push('');

  if (result.components) {
    lines.push(`Connected Components: ${result.components.length}`);
    for (const comp of result.components) {
      lines.push(`  Component ${comp.id}: ${comp.nodes?.length || 0} nodes`);
    }
  }

  if (result.orphans && result.orphans.length > 0) {
    lines.push('');
    lines.push(`--- Orphan Nodes (${result.orphans.length}) ---`);
    for (const o of result.orphans) lines.push(`  ${o}`);
  }

  if (result.dangling && result.dangling.length > 0) {
    lines.push('');
    lines.push(`--- Dangling References (${result.dangling.length}) ---`);
    for (const d of result.dangling) lines.push(`  ${d.from} -> ${d.to} (target not found)`);
  }

  if (result.cycles && result.cycles.length > 0) {
    lines.push('');
    lines.push(`--- Cycles (${result.cycles.length}) ---`);
    for (const cy of result.cycles) lines.push(`  ${cy.join(' -> ')}`);
  }

  return lines.join('\n');
}

function formatEntropyReport(result) {
  const lines = [];
  lines.push('=== Architecture Entropy Report ===');
  lines.push('');

  if (result.domainEntropy) {
    const de = result.domainEntropy;
    lines.push(`Domain Shannon Entropy: ${de.value.toFixed(4)} / ${de.max.toFixed(4)} (normalized: ${de.normalized.toFixed(4)})`);
  }

  if (result.coupling) {
    lines.push(`Coupling (cross-file xref): ${(result.coupling.value * 100).toFixed(1)}% (${result.coupling.crossFile}/${result.coupling.total})`);
  }

  if (result.cohesion) {
    lines.push(`Cohesion (within-domain): ${(result.cohesion.value * 100).toFixed(1)}% (${result.cohesion.withinDomain}/${result.cohesion.total})`);
  }

  if (result.depthEntropy) {
    const dpe = result.depthEntropy;
    lines.push(`Depth Entropy: ${dpe.value.toFixed(4)} / ${dpe.max.toFixed(4)}`);
    if (dpe.distribution && Object.keys(dpe.distribution).length > 0) {
      const dist = Object.entries(dpe.distribution).map(([d, r]) => `h${d}:${(r * 100).toFixed(0)}%`).join(' ');
      lines.push(`  Distribution: ${dist}`);
    }
  }

  if (result.gapEntropy) {
    lines.push(`GAP Entropy (std dev): ${result.gapEntropy.value.toFixed(4)}`);
    if (result.gapEntropy.domainRates) {
      const rates = Object.entries(result.gapEntropy.domainRates).map(([d, r]) => `${d}:${(r * 100).toFixed(0)}%`).join(' ');
      lines.push(`  Domain rates: ${rates}`);
    }
  }

  lines.push('');
  lines.push(`Overall Score: ${((result.overall || 0) * 100).toFixed(1)}%`);

  return lines.join('\n');
}

function pad(str, len) {
  return (str + ' '.repeat(len)).slice(0, len);
}

function pct(rate) {
  return pad(`${(rate * 100).toFixed(1)}%`, 8);
}

// === MCP 工具注册 ===

export function registerSpecAuditTools(server) {
  server.tool(
    'spec_audit',
    `SPEC 确定性成熟度审计。6 种模式：
maturity — 四层成熟度矩阵(SPEC→Design→Code→Test)
req_coverage — 逐 REQ 链接明细
test_quality — 测试质量四层级覆盖
cfg_chain — REQ→Entity→API→Test 链路完整性
dfs_connectivity — 引用图连通性(孤立/悬挂/循环)
architecture_entropy — 架构熵(Shannon/耦合/内聚/GAP熵)`,
    {
      dir: z.string().describe('SPEC 目录路径'),
      mode: z.enum(AUDIT_MODES).describe('审计模式'),
      sourceDir: z.string().optional().describe('源码根目录(maturity/entropy 的 Code 层需要)'),
      domain: z.string().optional().describe('按 domain 过滤(如 "auth"、"rtk")'),
      format: z.enum(['report', 'json']).default('report').describe('输出格式: report=可读报告 | json=结构化数据'),
    },
    (args) => {
      const result = runAudit(args.dir, args.mode, {
        sourceDir: args.sourceDir,
        domain: args.domain,
        format: args.format,
      });

      if (args.format === 'json' || result.format === 'json') {
        return { content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }] };
      }

      return { content: [{ type: 'text', text: result.text }] };
    },
  );
}
