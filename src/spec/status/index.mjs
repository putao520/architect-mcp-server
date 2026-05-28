import { readFileSync, writeFileSync } from 'node:fs';
import { parseHTML } from 'linkedom';
import { trackStatus, findStale } from './tracker.mjs';
import { reportMarkdown, reportJson } from './reporter.mjs';

export async function run(args) {
  const dir = args[0] || '.';
  const subcommand = args[1] || 'list';
  const format = args[2] || 'markdown';

  const { parseSpecDir } = await import('../parse/html-parser.mjs');
  const index = parseSpecDir(dir);

  if (subcommand === 'list') {
    const result = trackStatus(index);
    if (format === 'json') {
      console.log(reportJson(result));
    } else {
      console.log(reportMarkdown(result));
    }
  } else if (subcommand === 'update') {
    const reqId = args[2];
    const newStatus = args[3];
    if (!reqId || !newStatus) {
      console.log('Usage: spec status update <REQ-ID> <new-status>');
      process.exit(1);
    }
    updateStatus(index, reqId, newStatus);
    console.log(`Updated ${reqId} → ${newStatus}`);
  } else if (subcommand === 'stale') {
    const stale = findStale(index);
    for (const s of stale) console.log(`  ${s.file}/${s.req}: ${s.reason}`);
    if (stale.length === 0) console.log('  No stale REQ found.');
  }
}

function updateStatus(index, reqId, newStatus) {
  const validStatuses = ['draft', 'designed', 'implementing', 'implemented', 'blocked'];
  if (!validStatuses.includes(newStatus)) {
    throw new Error(`Invalid status: ${newStatus}. Valid: ${validStatuses.join(', ')}`);
  }

  for (const doc of index.docs) {
    for (const req of doc.reqs) {
      if (req.id !== reqId) continue;

      const raw = readFileSync(doc.filePath, 'utf8');
      const { document } = parseHTML(raw);

      const el = document.querySelector(`[data-req="${reqId}"]`);
      if (!el) throw new Error(`DOM element not found for REQ: ${reqId}`);

      el.setAttribute('data-req-status', newStatus);
      writeFileSync(doc.filePath, document.toString(), 'utf8');
      return;
    }
  }
  throw new Error(`REQ not found: ${reqId}`);
}
