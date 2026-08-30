import { WebSocketServer } from 'ws';

// The public key in extension/manifest.json pins this ID for unpacked installs.
// Accept only that extension's browser-controlled Origin header: ordinary web
// pages, opaque/null origins, other extensions, and origin-less clients are all
// rejected before the token handshake or any prompt data is exchanged.
export const EXTENSION_ORIGIN = 'chrome-extension://cjpcbbnjlfiidmbeeolnphpaeookdnpi';

function verifyClient({ origin }) {
  return origin === EXTENSION_ORIGIN;
}

/**
 * Ask the extension to reload itself (chrome.runtime.reload()), which re-reads
 * the unpacked extension's files from disk — closing the dev loop without
 * manually clicking "reload" in chrome://extensions.
 */
export function sendReload({ host = '127.0.0.1', port = 8767, connectTimeoutMs = 40_000, token = '' } = {}) {
  return new Promise((resolve, reject) => {
    const wss = new WebSocketServer({ host, port, verifyClient });
    let settled = false;
    let connectTimer = null;
    let fallbackTimer = null;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      if (connectTimer) clearTimeout(connectTimer);
      if (fallbackTimer) clearTimeout(fallbackTimer);
      try { for (const c of wss.clients) { try { c.terminate(); } catch { /* ignore */ } } } catch { /* ignore */ }
      try { wss.close(); } catch { /* ignore */ }
      fn(arg);
    };
    connectTimer = setTimeout(() => finish(reject, new Error(
      `No extension connected within ${Math.round(connectTimeoutMs / 1000)}s to reload.`)), connectTimeoutMs);
    wss.on('error', (err) => finish(reject, err));
    wss.on('connection', (ws) => {
      if (settled) return;
      // Stay silent until the client proves the token — don't volunteer it to
      // whoever happens to connect. Once the client auths, we prove ourselves
      // back (the extension only obeys a 'reload' from a server it trusts).
      ws.on('message', (data) => {
        let msg;
        try { msg = JSON.parse(data.toString()); } catch { return; }
        if (msg.type === 'ping') { try { ws.send(JSON.stringify({ type: 'pong' })); } catch { /* ignore */ } return; }
        if (msg.type !== 'hello') return;
        if (msg.token !== token) { try { ws.close(); } catch { /* ignore */ } return; }
        if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
        try { ws.send(JSON.stringify({ type: 'hello', token })); } catch { /* ignore */ }
        try { ws.send(JSON.stringify({ type: 'reload' })); } catch { /* ignore */ }
        // The worker tears down as it reloads, so the socket closing == success.
        ws.on('close', () => finish(resolve));
        fallbackTimer = setTimeout(() => finish(resolve), 1500); // fallback if close doesn't surface
      });
    });
  });
}

/**
 * Ask the extension to fetch ChatGPT's conversation JSON for the current user.
 * The caller formats the returned data locally so endpoint parsing is testable
 * without a browser.
 *
 * @returns {Promise<{data: object, conversation: string}>}
 */
export function dumpConversation({
  conversation,
  host = '127.0.0.1',
  port = 8767,
  connectTimeoutMs = 40_000,
  responseTimeoutMs = 6 * 60_000,
  token = '',
  onStatus = () => {},
}) {
  return new Promise((resolve, reject) => {
    const wss = new WebSocketServer({ host, port, verifyClient });
    const requestId = `dump-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

    let settled = false;
    let connected = false;
    let connectTimer = null;
    let responseTimer = null;

    const cleanup = () => {
      if (connectTimer) clearTimeout(connectTimer);
      if (responseTimer) clearTimeout(responseTimer);
      try { for (const c of wss.clients) { try { c.terminate(); } catch { /* ignore */ } } } catch { /* ignore */ }
      try { wss.close(); } catch { /* ignore */ }
    };
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(arg);
    };

    wss.on('error', (err) => {
      if (err && err.code === 'EADDRINUSE') {
        finish(reject, new Error(
          `Port ${port} is already in use — another prolink run may be active, ` +
          `or pass --port to use a different one.`));
      } else {
        finish(reject, err);
      }
    });

    connectTimer = setTimeout(() => {
      finish(reject, new Error(
        `No extension connected within ${Math.round(connectTimeoutMs / 1000)}s. ` +
        `Is Chrome running with the prolink extension loaded and a chatgpt.com login?`));
    }, connectTimeoutMs);

    wss.on('connection', (ws) => {
      if (settled) return;
      let authed = false;

      ws.on('message', (data) => {
        let msg;
        try { msg = JSON.parse(data.toString()); } catch { return; }
        if (msg.type === 'ping') { try { ws.send(JSON.stringify({ type: 'pong' })); } catch { /* ignore */ } return; }

        if (msg.type === 'hello') {
          if (msg.token !== token) { try { ws.close(); } catch { /* ignore */ } return; }
          authed = true;

          if (!connected) {
            connected = true;
            if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
            onStatus('extension connected');
            responseTimer = setTimeout(() => {
              finish(reject, new Error(
                `Timed out after ${Math.round(responseTimeoutMs / 1000)}s waiting for a transcript dump.`));
            }, responseTimeoutMs);
          } else {
            onStatus('extension reconnected');
          }

          try { ws.send(JSON.stringify({ type: 'hello', token })); } catch { /* ignore */ }
          try { ws.send(JSON.stringify({ type: 'dump', id: requestId, conversation, timeoutMs: responseTimeoutMs })); } catch { /* ignore */ }
          return;
        }

        if (!authed) return;
        if (msg.id !== requestId) return;
        if (msg.type === 'status') { onStatus(msg.stage || ''); return; }
        if (msg.type === 'dump-result') { finish(resolve, { data: msg.data || {}, conversation: msg.conversation || conversation || '' }); return; }
        if (msg.type === 'error') { finish(reject, new Error(msg.message || 'Unknown error from extension.')); }
      });
    });
  });
}

/**
 * Submit a single prompt by standing up a localhost WebSocket bridge, handing
 * it to the browser extension, and resolving once ChatGPT acknowledges it.
 *
 * The CLI is short-lived: it owns the WS server only for the duration of one
 * call. The extension's service worker keeps a reconnect loop running, so it
 * connects to us shortly after we start listening.
 *
 * @returns {Promise<{conversation: string, userMessageId: string}>} the
 *   accepted submission identity. Response generation continues independently
 *   and is read later from the conversation endpoint.
 */
export function runPrompt({
  prompt,
  model = '',
  effort = '',
  conversation = '',
  host = '127.0.0.1',
  port = 8767,
  connectTimeoutMs = 40_000,
  responseTimeoutMs = 6 * 60_000,
  token = '',
  debug = false,
  onStatus = () => {},
  requestId = `req-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
}) {
  return new Promise((resolve, reject) => {
    const wss = new WebSocketServer({ host, port, verifyClient });

    let settled = false;
    let connected = false;
    let connectTimer = null;
    let responseTimer = null;

    const cleanup = () => {
      if (connectTimer) clearTimeout(connectTimer);
      if (responseTimer) clearTimeout(responseTimer);
      // Force-close any connected client. wss.close() alone only stops new
      // connections; it won't resolve while the extension keeps its socket
      // open, which would keep the Node process alive after we've printed.
      try { for (const c of wss.clients) { try { c.terminate(); } catch { /* ignore */ } } } catch { /* ignore */ }
      try { wss.close(); } catch { /* ignore */ }
    };
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(arg);
    };

    wss.on('error', (err) => {
      if (err && err.code === 'EADDRINUSE') {
        finish(reject, new Error(
          `Port ${port} is already in use — another prolink run may be active, ` +
          `or pass --port to use a different one.`));
      } else {
        finish(reject, err);
      }
    });

    connectTimer = setTimeout(() => {
      finish(reject, new Error(
        `No extension connected within ${Math.round(connectTimeoutMs / 1000)}s. ` +
        `Is Chrome running with the prolink extension loaded and a chatgpt.com login?`));
    }, connectTimeoutMs);

    wss.on('connection', (ws) => {
      if (settled) return;
      let authed = false;

      // Stay silent until the client proves the token, so a stray local client
      // can't receive our token (and then spoof a result or lift the prompt).
      // Only once it auths do we prove ourselves back and hand over the job.
      ws.on('message', (data) => {
        let msg;
        try { msg = JSON.parse(data.toString()); } catch { return; }
        if (msg.type === 'ping') { try { ws.send(JSON.stringify({ type: 'pong' })); } catch { /* ignore */ } return; }

        if (msg.type === 'hello') {
          if (msg.token !== token) { try { ws.close(); } catch { /* ignore */ } return; }
          authed = true;

          if (!connected) {
            connected = true;
            if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
            onStatus('extension connected');
            responseTimer = setTimeout(() => {
              finish(reject, new Error(
                `Timed out after ${Math.round(responseTimeoutMs / 1000)}s waiting for ChatGPT to accept the submission.`));
            }, responseTimeoutMs);
          } else {
            onStatus('extension reconnected');
          }

          // Prove ourselves to the extension (it ignores a prompt from an
          // untrusted server), then (re)hand the job. An MV3 worker can be
          // killed and revived by its alarm mid-run; on reconnect we give it the
          // same job again. The extension persists the job id + tab across
          // restarts, so a revived worker re-attaches to the tab it already
          // opened rather than opening a second one and submitting twice.
          try { ws.send(JSON.stringify({ type: 'hello', token })); } catch { /* ignore */ }
          try { ws.send(JSON.stringify({ type: 'prompt', id: requestId, prompt, model, effort, conversation, timeoutMs: responseTimeoutMs, debug })); } catch { /* ignore */ }
          return;
        }

        if (!authed) return; // ignore everything else until the client proves the token
        if (msg.id !== requestId) return;
        if (msg.type === 'status') { onStatus(msg.stage || ''); return; }
        if (msg.type === 'submitted' || msg.type === 'result') {
          finish(resolve, {
            conversation: msg.conversation || '',
            userMessageId: msg.userMessageId || '',
          });
          return;
        }
        if (msg.type === 'error') {
          const err = new Error(msg.message || 'Unknown error from extension.');
          if (msg.conversation) err.conversation = msg.conversation; // so the CLI can still report the thread
          finish(reject, err);
        }
      });

      // Deliberately no reject on 'close' — a dropped worker will reconnect and
      // we'll re-hand it the job. The submission timeout bounds the whole wait.
    });
  });
}
