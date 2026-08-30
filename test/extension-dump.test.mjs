import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

function response(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return data; },
    async text() { return typeof data === 'string' ? data : JSON.stringify(data); },
  };
}

const code = await readFile('extension/dump.js', 'utf8');
const context = { setTimeout, clearTimeout, AbortController, fetch: async () => { throw new Error('unexpected fetch'); } };
vm.runInNewContext(code, context, { filename: 'extension/dump.js' });
const { conversationEndpointId, fetchConversationJson } = context.prolinkDump;

assert.equal(conversationEndpointId('conv-abc'), 'conv-abc');
assert.equal(conversationEndpointId('g/gizmo-slug/c/conv-xyz'), 'conv-xyz');
assert.throws(() => conversationEndpointId('g/gizmo-slug/not-c/conv-xyz'), /invalid conversation id/);

const calls = [];
const fixture = { title: 'Endpoint fixture', current_node: 'n1', mapping: { n1: { id: 'n1', parent: null, message: null } } };
const data = await fetchConversationJson('g/gizmo/c/conv-xyz', {
  timeoutMs: 5000,
  fetchImpl: async (url, opts) => {
    calls.push({ url, opts });
    if (url.endsWith('/api/auth/session')) return response({ accessToken: 'token-123' });
    return response(fixture);
  },
});
assert.equal(data.conversation_id, 'conv-xyz');
assert.equal(calls.length, 2);
assert.equal(calls[0].opts.credentials, 'include');
assert.equal(calls[1].url, 'https://chatgpt.com/backend-api/conversation/conv-xyz');
assert.equal(calls[1].opts.credentials, 'include');
assert.equal(calls[1].opts.headers.authorization, 'Bearer token-123');

const retryCalls = [];
const retryData = await fetchConversationJson('conv-retry', {
  fetchImpl: async (url, opts) => {
    retryCalls.push({ url, opts });
    if (url.endsWith('/api/auth/session')) return response({ accessToken: 'stale-token' });
    if (opts.headers.authorization) return response('expired', 401);
    return response({ current_node: 'n1', mapping: { n1: { id: 'n1', parent: null, message: null } } });
  },
});
assert.equal(retryData.conversation_id, 'conv-retry');
assert.equal(retryCalls.length, 3);
assert.equal(retryCalls[1].opts.headers.authorization, 'Bearer stale-token');
assert.equal(retryCalls[2].opts.headers.authorization, undefined);

const cookieOnlyCalls = [];
const cookieOnlyData = await fetchConversationJson('conv-cookie', {
  fetchImpl: async (url, opts) => {
    cookieOnlyCalls.push({ url, opts });
    if (url.endsWith('/api/auth/session')) throw new Error('session endpoint unavailable');
    return response({ current_node: 'n1', mapping: { n1: { id: 'n1', parent: null, message: null } } });
  },
});
assert.equal(cookieOnlyData.conversation_id, 'conv-cookie');
assert.equal(cookieOnlyCalls.length, 2);
assert.equal(cookieOnlyCalls[1].opts.credentials, 'include');
assert.equal(cookieOnlyCalls[1].opts.headers.authorization, undefined);

await assert.rejects(
  fetchConversationJson('conv-auth', {
    fetchImpl: async (url) => url.endsWith('/api/auth/session') ? response({}, 200) : response('forbidden', 403),
  }),
  /ChatGPT authentication failed.*cookie-only auth was rejected/,
);

await assert.rejects(
  fetchConversationJson('conv-404', {
    fetchImpl: async (url) => url.endsWith('/api/auth/session') ? response({}, 200) : response('missing', 404),
  }),
  /not found or is not accessible/,
);

await assert.rejects(
  fetchConversationJson('conv-bad', {
    fetchImpl: async (url) => url.endsWith('/api/auth/session') ? response({ accessToken: 't' }) : response({ nope: true }),
  }),
  /unexpected JSON \(missing conversation mapping\)/,
);

console.log('  ok   extension endpoint dump helpers');
