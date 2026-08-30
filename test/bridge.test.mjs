// Integration tests for the localhost WebSocket bridge (src/server.js).
//
// These drive runPrompt()/sendReload() with a `ws` client standing in for the
// extension's service worker, exercising the token handshake, the origin
// rejection, and the reconnect re-hand. The extension's own logic
// (background.js / content.js) needs a real browser and isn't covered here.
//
// Run: node test/bridge.test.mjs
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import WebSocket, { WebSocketServer } from 'ws';
import { dumpConversation, EXTENSION_ORIGIN, runPrompt, sendReload } from '../src/server.js';

const HOST = '127.0.0.1';
const TOKEN = 'test-token-123';
const EXT_ORIGIN = EXTENSION_ORIGIN;
let nextPort = 8810;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    console.error(`  FAIL ${name}\n       ${e.message}`);
    process.exitCode = 1;
  }
}

await test('manifest key pins the allowed extension origin', async () => {
  const manifest = JSON.parse(await readFile(new URL('../extension/manifest.json', import.meta.url), 'utf8'));
  const publicKey = Buffer.from(manifest.key, 'base64');
  const idHex = createHash('sha256').update(publicKey).digest('hex').slice(0, 32);
  const extensionId = [...idHex]
    .map((digit) => String.fromCharCode('a'.charCodeAt(0) + parseInt(digit, 16)))
    .join('');
  assert.equal(EXTENSION_ORIGIN, `chrome-extension://${extensionId}`);
});

// ---- happy path: mutual auth, prompt handed over, submission acknowledged ----
await test('runPrompt: auth handshake + submission identity round-trip', async () => {
  const port = nextPort++;
  const p = runPrompt({ host: HOST, port, token: TOKEN, prompt: 'ping?', model: '5.6 Sol', effort: 'Medium', conversation: 'conv-xyz', connectTimeoutMs: 3000, responseTimeoutMs: 3000 });

  let gotServerHello = false;
  let promptMsg = null;
  const ws = new WebSocket(`ws://${HOST}:${port}`, { origin: EXT_ORIGIN });
  ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', token: TOKEN })));
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    if (m.type === 'hello') { gotServerHello = true; assert.equal(m.token, TOKEN); }
    if (m.type === 'prompt') {
      promptMsg = m;
      ws.send(JSON.stringify({ type: 'submitted', id: m.id, conversation: 'conv-abc', userMessageId: 'user-abc' }));
    }
  });

  const { conversation, userMessageId } = await p;
  ws.close();
  assert.equal(conversation, 'conv-abc', 'conversation id should round-trip back to the caller');
  assert.equal(userMessageId, 'user-abc', 'submitted user message id should round-trip back to the caller');
  assert.ok(gotServerHello, 'server should prove its token back');
  assert.equal(promptMsg.prompt, 'ping?');
  assert.equal(promptMsg.model, '5.6 Sol');
  assert.equal(promptMsg.effort, 'Medium');
  assert.equal(promptMsg.conversation, 'conv-xyz', 'the -c continue id should reach the page');
  assert.equal(promptMsg.timeoutMs, 3000, 'CLI response timeout should reach the page');
});

await test('runPrompt: accepts a caller-supplied request id', async () => {
  const port = nextPort++;
  const p = runPrompt({ host: HOST, port, token: TOKEN, prompt: 'ping?', requestId: 'job-test-123', connectTimeoutMs: 3000, responseTimeoutMs: 3000 });

  let promptMsg = null;
  const ws = new WebSocket(`ws://${HOST}:${port}`, { origin: EXT_ORIGIN });
  ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', token: TOKEN })));
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    if (m.type === 'prompt') {
      promptMsg = m;
      ws.send(JSON.stringify({ type: 'submitted', id: m.id, conversation: 'conv-id', userMessageId: 'user-id' }));
    }
  });

  await p;
  ws.close();
  assert.equal(promptMsg.id, 'job-test-123');
});

// ---- dump path: mutual auth, dump job handed over, endpoint JSON returned ----
await test('dumpConversation: auth handshake + dump result round-trip', async () => {
  const port = nextPort++;
  const fixture = { title: 'Fixture chat', mapping: {}, current_node: null };
  const p = dumpConversation({ host: HOST, port, token: TOKEN, conversation: 'conv-dump', connectTimeoutMs: 3000, responseTimeoutMs: 3000 });

  let gotServerHello = false;
  let dumpMsg = null;
  const ws = new WebSocket(`ws://${HOST}:${port}`, { origin: EXT_ORIGIN });
  ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', token: TOKEN })));
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    if (m.type === 'hello') { gotServerHello = true; assert.equal(m.token, TOKEN); }
    if (m.type === 'dump') { dumpMsg = m; ws.send(JSON.stringify({ type: 'dump-result', id: m.id, data: fixture, conversation: 'conv-dump' })); }
  });

  const { data, conversation } = await p;
  ws.close();
  assert.equal(conversation, 'conv-dump');
  assert.deepEqual(data, fixture);
  assert.ok(gotServerHello, 'server should prove its token back');
  assert.equal(dumpMsg.conversation, 'conv-dump');
  assert.equal(dumpMsg.timeoutMs, 3000, 'CLI response timeout should reach the extension');
});

// ---- the server must not reveal its token before the client authenticates ----
await test('runPrompt: server stays silent until client proves the token', async () => {
  const port = nextPort++;
  const p = runPrompt({ host: HOST, port, token: TOKEN, prompt: 'x', connectTimeoutMs: 800, responseTimeoutMs: 3000 });
  p.catch(() => {}); // expected to reject; assert below

  const seen = [];
  const ws = new WebSocket(`ws://${HOST}:${port}`, { origin: EXT_ORIGIN });
  // Connect but never send a valid hello — we should receive nothing.
  ws.on('message', (d) => seen.push(JSON.parse(d.toString()).type));
  await sleep(400);
  assert.deepEqual(seen, [], 'server leaked messages before auth');
  ws.close();
  await assert.rejects(p, /No extension connected/);
});

// ---- wrong token is rejected (socket closed, no prompt handed over) ----
await test('runPrompt: wrong token gets no prompt', async () => {
  const port = nextPort++;
  const p = runPrompt({ host: HOST, port, token: TOKEN, prompt: 'x', connectTimeoutMs: 800, responseTimeoutMs: 3000 });
  p.catch(() => {});

  let gotPrompt = false;
  const ws = new WebSocket(`ws://${HOST}:${port}`, { origin: EXT_ORIGIN });
  ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', token: 'WRONG' })));
  ws.on('message', (d) => { if (JSON.parse(d.toString()).type === 'prompt') gotPrompt = true; });
  await assert.rejects(p, /No extension connected/);
  assert.equal(gotPrompt, false);
});

// ---- a web-page origin is refused at the WS handshake ----
await test('runPrompt: http(s) origin is rejected by verifyClient', async () => {
  const port = nextPort++;
  const p = runPrompt({ host: HOST, port, token: TOKEN, prompt: 'x', connectTimeoutMs: 800, responseTimeoutMs: 3000 });
  p.catch(() => {});

  let opened = false;
  const ws = new WebSocket(`ws://${HOST}:${port}`, { origin: 'https://evil.example' });
  ws.on('open', () => { opened = true; });
  ws.on('error', () => {}); // expected: handshake rejected
  await sleep(400);
  assert.equal(opened, false, 'web-page origin should not be allowed to connect');
  await assert.rejects(p, /No extension connected/);
});

// ---- an opaque/sandboxed page origin is refused at the WS handshake ----
await test('runPrompt: null origin is rejected by verifyClient', async () => {
  const port = nextPort++;
  const p = runPrompt({ host: HOST, port, token: TOKEN, prompt: 'x', connectTimeoutMs: 800, responseTimeoutMs: 3000 });
  p.catch(() => {});

  let opened = false;
  const ws = new WebSocket(`ws://${HOST}:${port}`, { origin: 'null' });
  ws.on('open', () => { opened = true; });
  ws.on('error', () => {}); // expected: handshake rejected
  await sleep(400);
  assert.equal(opened, false, 'null origin should not be allowed to connect');
  await assert.rejects(p, /No extension connected/);
});

// ---- a different extension cannot impersonate Prolink ----
await test('runPrompt: unrelated extension origin is rejected by verifyClient', async () => {
  const port = nextPort++;
  const p = runPrompt({ host: HOST, port, token: TOKEN, prompt: 'x', connectTimeoutMs: 800, responseTimeoutMs: 3000 });
  p.catch(() => {});

  let opened = false;
  const ws = new WebSocket(`ws://${HOST}:${port}`, {
    origin: 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  });
  ws.on('open', () => { opened = true; });
  ws.on('error', () => {}); // expected: handshake rejected
  await sleep(400);
  assert.equal(opened, false, 'another extension should not be allowed to connect');
  await assert.rejects(p, /No extension connected/);
});

// ---- reconnect: worker drops mid-job, a fresh connection is re-handed it ----
await test('runPrompt: re-hands the job to a reconnecting worker', async () => {
  const port = nextPort++;
  const p = runPrompt({ host: HOST, port, token: TOKEN, prompt: 'q', connectTimeoutMs: 3000, responseTimeoutMs: 5000 });

  // Worker A: auth, receive the prompt, then drop without answering.
  const a = new WebSocket(`ws://${HOST}:${port}`, { origin: EXT_ORIGIN });
  a.on('open', () => a.send(JSON.stringify({ type: 'hello', token: TOKEN })));
  await new Promise((resolve) => {
    a.on('message', (d) => {
      const m = JSON.parse(d.toString());
      if (m.type === 'prompt') { assert.equal(m.prompt, 'q'); a.close(); resolve(); }
    });
  });

  await sleep(100); // let the server observe the close

  // Worker B (the "revived" worker): auth and expect the same job again.
  let rehandedId = null;
  const b = new WebSocket(`ws://${HOST}:${port}`, { origin: EXT_ORIGIN });
  b.on('open', () => b.send(JSON.stringify({ type: 'hello', token: TOKEN })));
  b.on('message', (d) => {
    const m = JSON.parse(d.toString());
    if (m.type === 'prompt') {
      rehandedId = m.id;
      b.send(JSON.stringify({ type: 'submitted', id: m.id, conversation: 'conv-recovered', userMessageId: 'user-recovered' }));
    }
  });

  const { conversation } = await p;
  b.close();
  assert.equal(conversation, 'conv-recovered');
  assert.ok(rehandedId, 'reconnecting worker should be re-handed the job');
});

// ---- sendReload: auth then reload, resolves on socket close ----
await test('sendReload: hands a reload to an authed client', async () => {
  const port = nextPort++;
  const r = sendReload({ host: HOST, port, token: TOKEN, connectTimeoutMs: 3000 });

  let gotReload = false;
  const ws = new WebSocket(`ws://${HOST}:${port}`, { origin: EXT_ORIGIN });
  ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', token: TOKEN })));
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    if (m.type === 'reload') { gotReload = true; ws.close(); } // mimic the worker tearing down
  });

  await r;
  assert.ok(gotReload, 'authed client should receive a reload');
});

// ---- the server must release the port even if the client stays connected ----
// (the extension keeps its socket open between jobs; if we don't force-close it,
// the Node process never exits — this is what left CLI runs hanging)
await test('runPrompt: releases the port even with a client still connected', async () => {
  const port = nextPort++;
  const p = runPrompt({ host: HOST, port, token: TOKEN, prompt: 'x', connectTimeoutMs: 3000, responseTimeoutMs: 3000 });
  const ws = new WebSocket(`ws://${HOST}:${port}`, { origin: EXT_ORIGIN });
  ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', token: TOKEN })));
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    if (m.type === 'prompt') {
      ws.send(JSON.stringify({ type: 'submitted', id: m.id, conversation: 'conv-ok', userMessageId: 'user-ok' }));
    }
  });
  await p;
  // Deliberately do NOT close `ws` — mimic the extension holding its socket.
  await sleep(50);
  await new Promise((resolve, reject) => {
    const probe = new WebSocketServer({ host: HOST, port });
    probe.on('listening', () => probe.close(() => resolve()));
    probe.on('error', reject); // EADDRINUSE => the port was never released
  });
});

console.log(`\n${passed} passed${process.exitCode ? ', with failures' : ''}`);
// Give sockets a tick to close so the process exits cleanly.
await sleep(100);
process.exit(process.exitCode || 0);
