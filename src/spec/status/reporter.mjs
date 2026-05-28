export function reportMarkdown(statusResult) {
  const lines = ['| Domain | Total | draft | designed | implementing | implemented | blocked |', '|--------|-------|-------|----------|-------------|-------------|---------|'];

  for (const [domain, reqs] of statusResult.byDomain) {
    const counts = { draft: 0, designed: 0, implementing: 0, implemented: 0, blocked: 0 };
    for (const r of reqs) counts[r.status] = (counts[r.status] || 0) + 1;
    lines.push(`| ${domain} | ${reqs.length} | ${counts.draft} | ${counts.designed} | ${counts.implementing} | ${counts.implemented} | ${counts.blocked} |`);
  }

  lines.push('');
  lines.push(`**Total: ${statusResult.total} REQ**`);

  for (const [status, count] of statusResult.byStatus) {
    lines.push(`- ${status}: ${count}`);
  }

  return lines.join('\n');
}

export function reportJson(statusResult) {
  const data = {};
  for (const [domain, reqs] of statusResult.byDomain) {
    data[domain] = {
      total: reqs.length,
      reqs: reqs.map(r => ({ id: r.id, status: r.status, title: r.title })),
    };
  }
  return JSON.stringify({ total: statusResult.total, domains: data }, null, 2);
}