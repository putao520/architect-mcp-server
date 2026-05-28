#!/usr/bin/env node
// Test: start a long generation, kill client after 5s, verify server recovers
import WebSocket from 'ws';

const PORT = 19876;
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);

let requestId = 0;
function send(msg) {
  const id = String(++requestId);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timeout')), 60000);
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
  console.log('[1] Connected');
  const { sessionId } = await send({ type: 'session.create' });
  console.log('[2] Session:', sessionId.slice(0,8));

  // Feed a short prompt (just enough to prime the model)
  await send({ type: 'session.feedPrompt', sessionId, text: 'User: Tell me a story.\nAssistant:' });
  console.log('[3] Prompt fed (short)');

  // Start generation (will take many seconds)
  console.log('[4] Starting generation (will kill client in 3s)...');
  send({ type: 'session.generate', sessionId, maxTokens: 10000 }).catch(() => {});

  // Kill client after 3 seconds
  setTimeout(() => {
    console.log('[5] Killing client (simulating disconnect)...');
    ws.terminate();
  }, 3000);
});

ws.on('close', () => {
  console.log('[6] Client disconnected');
});
