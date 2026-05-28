#!/usr/bin/env node
// Quick test: stateless GPU eval — single session feedPrompt + generate
import WebSocket from 'ws';

const PORT = 19876;
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);

let requestId = 0;
function send(msg) {
  const id = String(++requestId);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timeout')), 120_000);
    const handler = (raw) => {
      const data = JSON.parse(raw);
      if (data.requestId === id) {
        if (data.type === 'error') { clearTimeout(timeout); ws.off('message', handler); reject(new Error(data.message)); return; }
        clearTimeout(timeout);
        ws.off('message', handler);
        resolve(data);
      }
    };
    ws.on('message', handler);
    ws.send(JSON.stringify({ ...msg, requestId: id }));
  });
}

ws.on('open', async () => {
  console.log('[WS] Connected');
  try {
    // 1. Create session
    const created = await send({ type: 'session.create' });
    const sid = created.sessionId;
    console.log(`[1] Session created: ${sid.slice(0,8)}`);

    // 2. Feed prompt
    await send({ type: 'session.feedPrompt', sessionId: sid, text: 'User: What is 2+2? Answer briefly.\nAssistant:' });
    console.log('[2] Prompt fed');

    // 3. Generate
    const gen = await send({ type: 'session.generate', sessionId: sid, maxTokens: 64, options: {} });
    console.log(`[3] Generated: "${gen.text?.slice(0, 100)}" (tokens: ${gen.tokenCount})`);

    // 4. Export state
    const exported = await send({ type: 'session.exportState', sessionId: sid });
    console.log(`[4] State exported: ${exported.stateB64?.length} bytes base64`);

    // 5. Create new session, import state, continue generation
    const created2 = await send({ type: 'session.create' });
    const sid2 = created2.sessionId;
    await send({ type: 'session.importState', sessionId: sid2, stateB64: exported.stateB64 });
    console.log(`[5] State imported into new session ${sid2.slice(0,8)}`);

    const gen2 = await send({ type: 'session.generate', sessionId: sid2, maxTokens: 32, options: {} });
    console.log(`[6] Continue gen: "${gen2.text?.slice(0, 100)}"`);

    // 7. Cleanup
    await send({ type: 'session.destroy', sessionId: sid });
    await send({ type: 'session.destroy', sessionId: sid2 });
    console.log('[7] Sessions destroyed');

    console.log('\n[RESULT] ALL TESTS PASSED');
  } catch (e) {
    console.error('[FAIL]', e.message);
  }
  ws.close();
  process.exit(0);
});

ws.on('error', (e) => { console.error('[WS ERROR]', e.message); process.exit(1); });
