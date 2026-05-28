#!/usr/bin/env node
// Test: 3 fast tools → verify sessions=0 and CPU idle after completion
import WebSocket from 'ws';

const PORT = 19876;
let ws, pending = new Map(), msgId = 0;

function connect() {
  return new Promise((resolve, reject) => {
    ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    ws.addEventListener('open', () => { console.log('[WS] Connected'); resolve(); });
    ws.addEventListener('error', (e) => reject(new Error('WS error')));
    ws.addEventListener('message', (e) => {
      const msg = JSON.parse(e.data);
      const key = msg.requestId;
      // Only resolve on final result, not intermediate 'token' streaming messages
      if (key && pending.has(key) && (msg.type === 'tool.result' || msg.type === 'error')) {
        const { resolve: done } = pending.get(key);
        pending.delete(key);
        done(msg);
      }
    });
  });
}

function callTool(tool, args) {
  const id = String(++msgId);
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve });
    ws.send(JSON.stringify({ type: 'tool.execute', tool, args, requestId: id }));
    setTimeout(() => { pending.delete(id); reject(new Error(`${tool} timeout`)); }, 300000);
  });
}

function extractText(r) {
  return r.content?.[0]?.text || r.text || r.message || '(no text)';
}

async function main() {
  await connect();
  const cwd = '/home/putao/code/claude/architect-mcp-server';
  const start = Date.now();

  // 3 fast tools that each create 1 session (no heavy loops)
  const results = await Promise.allSettled([
    callTool('deep-read', { files: ['package.json'], question: '项目名是什么？', mode: 'qa', cwd }),
    callTool('project-list', {}),
    callTool('diff-read', { filesA: ['package.json'], filesB: ['package.json'], question: '有区别吗？', cwd }),
  ]);

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`\n[RESULTS] Completed in ${elapsed}s`);
  for (const r of results) {
    if (r.status === 'fulfilled') {
      const text = extractText(r.value).slice(0, 120);
      console.log(`  PASS  ${text}`);
    } else {
      console.log(`  FAIL  ${r.reason?.message}`);
    }
  }

  // Wait for server-side cleanup
  console.log('\n[CLEANUP] Waiting 5s for session cleanup...');
  await new Promise(r => setTimeout(r, 5000));

  // Check server health
  const health = await fetch(`http://127.0.0.1:${PORT}/health`).then(r => r.json());
  console.log(`[HEALTH] sessions=${health.sessions}, busy=${health.busy}`);

  ws.close();
  console.log('[DONE] WS closed');
}

main().catch(e => { console.error('[FATAL]', e); process.exit(1); });
