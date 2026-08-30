// prolink service worker.
//
// Maintains a connection to the local CLI bridge (ws://127.0.0.1:PORT) and,
// when a prompt arrives, opens a fresh chatgpt.com tab and hands the work to
// the content script. MV3 service workers are killed after ~30s idle, so we
// rely on a keepalive alarm to revive + reconnect, and on periodic ping
// messages to stay alive while a request is in flight.

importScripts('dump.js');

const PORT = 8767; // keep in sync with src/config.js
const WS_URL = `ws://127.0.0.1:${PORT}`;
const KEEPALIVE_ALARM = 'prolink-keepalive';

// Shared secret for the local bridge. Keep in sync with `token` in
// src/config.js (and any PROLINK_TOKEN override). We refuse to act on a
// prompt/reload from a server that can't present this token. Caveat: we send
// the token when we connect, so a process that squats the bridge port can
// learn it; an HMAC challenge-response handshake (deferred) would close that.
const BRIDGE_TOKEN = 'pl_3f9c1a7e8b2d4654a1c0e5f6079b8d2c';

const JOB_KEY = 'prolink-job'; // chrome.storage.session: { id, tabId }
const SUBMIT_PREFIX = 'prolink-submit-'; // content-owned submit state; keep in sync with content.js

// Temporary reliability workaround: ChatGPT now defers parts of its composer
// and model picker in background tabs, so keep the submission tab active.
const OPEN_TAB_ACTIVE = true;

let socket = null;
let keepaliveTimer = null;
let currentJobId = null;
let reconnectTimer = null;
let serverTrusted = false; // set once the server proves it knows BRIDGE_TOKEN

// Grant content scripts access to chrome.storage.session (default is extension
// contexts only) so they can keep durable submit-state that survives a page
// reload. handlePrompt AWAITS this before asking a content script to run, so the
// content script can't read storage before the grant lands and wrongly conclude
// "fresh" (which could double-submit). The grant persists across worker
// restarts, so re-running it on every spin-up is harmless. Resolves false on
// Chrome too old to support it — then content's de-dup fails closed (refuses).
const storageReady = (async () => {
  try { await chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' }); return true; }
  catch { return false; }
})();

function log(...a) { console.log('[prolink]', ...a); }

// Fast reconnect while the worker is alive (e.g. right after a self-reload, or
// when the CLI server reappears). The 30s keepalive alarm is the backstop for
// when the worker has been killed entirely.
function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, 2000);
}

// Keep the MV3 service worker alive while connected. MV3 kills an idle worker
// after ~30s, which would drop our connection mid-request. A cheap async API
// call resets that idle timer; we also ping the bridge so it stays aware of us.
function startKeepalive() {
  stopKeepalive();
  const tick = () => {
    chrome.runtime.getPlatformInfo(() => {}); // resets the SW idle timer
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'ping' }));
    }
  };
  tick(); // fire immediately — a cold-woken worker can die before a delayed first tick
  keepaliveTimer = setInterval(tick, 15_000);
}
function stopKeepalive() {
  if (keepaliveTimer) { clearInterval(keepaliveTimer); keepaliveTimer = null; }
}

function connect() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }
  try {
    socket = new WebSocket(WS_URL);
  } catch (e) {
    return; // CLI not running; the alarm will retry.
  }

  socket.onopen = () => {
    log('connected to bridge');
    serverTrusted = false;
    startKeepalive();
    send({ type: 'hello', token: BRIDGE_TOKEN }); // prove ourselves to the server
  };

  socket.onclose = () => {
    log('bridge closed');
    serverTrusted = false;
    stopKeepalive();
    scheduleReconnect();
  };

  socket.onerror = () => { /* onclose will follow */ };

  socket.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === 'hello') { serverTrusted = (msg.token === BRIDGE_TOKEN); return; }
    if (msg.type === 'pong') return;
    if (!serverTrusted) return; // ignore commands until the server proves the token
    if (msg.type === 'reload') { log('reload requested by CLI'); chrome.runtime.reload(); return; }
    if (msg.type === 'prompt') handlePrompt(msg);
    if (msg.type === 'dump') handleDump(msg);
  };
}

function send(obj) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(obj));
    return true;
  }
  return false;
}

const status = (id, stage) => send({ type: 'status', id, stage });

// Persisted across worker restarts so a revived worker re-attaches to the tab
// it already opened (see handlePrompt). chrome.storage.session is in-memory and
// cleared when the browser closes — exactly the lifetime we want.
function loadJob() {
  return new Promise((resolve) => {
    chrome.storage.session.get(JOB_KEY, (o) => {
      resolve((!chrome.runtime.lastError && o && o[JOB_KEY]) || null);
    });
  });
}
function clearJob(id) {
  // Also drop the content-owned submit marker for this id so it doesn't linger
  // for the rest of the browser session.
  const keys = id ? [JOB_KEY, SUBMIT_PREFIX + id] : [JOB_KEY];
  return new Promise((resolve) => chrome.storage.session.remove(keys, () => resolve()));
}
function tabExists(tabId) {
  if (tabId == null) return Promise.resolve(false);
  return new Promise((resolve) => {
    chrome.tabs.get(tabId, (tab) => resolve(!chrome.runtime.lastError && !!tab));
  });
}

async function handleDump({ id, conversation, timeoutMs }) {
  try {
    status(id, 'fetching conversation');
    if (!globalThis.prolinkDump || !globalThis.prolinkDump.fetchConversationJson) throw new Error('conversation dump helper failed to load');
    const data = await globalThis.prolinkDump.fetchConversationJson(conversation, { timeoutMs });
    send({ type: 'dump-result', id, data, conversation });
  } catch (e) {
    send({ type: 'error', id, message: String((e && e.message) || e) });
  }
}

async function handlePrompt({ id, prompt, model, effort, timeoutMs, debug, conversation }) {
  if (currentJobId === id) return; // already handling this job on this live worker
  currentJobId = id;

  let delivered = false;
  let succeeded = false;
  try {
    // Re-attach if this is the same job we already started before the worker
    // was killed: reuse the existing tab instead of opening a second one. The
    // content script de-dupes by id too, so the prompt is never re-submitted.
    let tabId = null;
    const saved = await loadJob();
    if (saved && saved.id === id && await tabExists(saved.tabId)) {
      tabId = saved.tabId;
      status(id, 'reattaching');
    } else {
      status(id, conversation ? 'opening conversation' : 'opening new chat');
      tabId = await openChatTab(id, conversation); // persists {id,tabId} as it creates the tab
    }

    status(id, 'waiting for page');
    await waitForComplete(tabId);
    // Ensure content scripts can use chrome.storage.session before we ask one to
    // run — its durable de-dup (and the no-double-submit guarantee) depends on it.
    await storageReady;
    status(id, 'sending prompt');
    const res = await sendToContent(tabId, { type: 'run', id, prompt, model, effort, timeoutMs, conversation: conversation || '' });

    if (res && res.ok) {
      if (res.reattached && debug) status(id, 'submission already acknowledged');
      delivered = send({
        type: 'submitted',
        id,
        conversation: res.conversation || '',
        userMessageId: res.userMessageId || '',
      });
      succeeded = delivered;
    } else {
      const extra = res && res.options && res.options.length
        ? ` — choices seen in picker: ${res.options.join(' | ')}`
        : '';
      const diag = res && res.diag ? `\n\n[diagnostics]\n${res.diag}` : '';
      delivered = send({ type: 'error', id, message: (res && res.error || 'content script failed') + extra + diag, conversation: res && res.conversation || '' });
    }
  } catch (e) {
    delivered = send({ type: 'error', id, message: String((e && e.message) || e) });
  } finally {
    currentJobId = null;
    // Once the short submission acknowledgement has reached the bridge, the
    // browser tab is no longer part of the job lifecycle. ChatGPT keeps
    // generating server-side and later status/result commands use its endpoint.
    if (succeeded) await clearJob(id);
  }
}

function openChatTab(id, conversation) {
  // A conversation handle opens that existing thread to continue it; otherwise
  // the root URL starts a new chat. The handle is either a bare id ("<uuid>" →
  // /c/<uuid>) or a full path ("g/<gizmo>/c/<uuid>" for a GPT/Project chat).
  // Encode per segment (keeping the slashes) — the CLI already validates the
  // charset, this is belt-and-suspenders.
  let url = 'https://chatgpt.com/';
  if (conversation) {
    const safe = conversation.split('/').map(encodeURIComponent).join('/');
    url = conversation.includes('/') ? `https://chatgpt.com/${safe}` : `https://chatgpt.com/c/${safe}`;
  }
  // Persist {id,tabId} inside the create callback so the record exists as soon
  // as the tab does. If the worker dies before this fires we may leak a blank
  // tab, but the prompt isn't submitted until later (sendToContent), so a
  // half-created job can never double-submit.
  return new Promise((resolve) => {
    chrome.tabs.create({ url, active: OPEN_TAB_ACTIVE }, (tab) => {
      chrome.storage.session.set({ [JOB_KEY]: { id, tabId: tab.id } }, () => resolve(tab.id));
    });
  });
}

function waitForComplete(tabId) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    };
    const listener = (updatedId, info) => {
      if (updatedId === tabId && info.status === 'complete') finish();
    };
    chrome.tabs.onUpdated.addListener(listener);
    // Handle the case where it's already complete before we attached.
    chrome.tabs.get(tabId, (tab) => {
      if (!chrome.runtime.lastError && tab && tab.status === 'complete') finish();
    });
  });
}

// Retry until the content script is injected and acknowledges the submission
// (it may not exist for a beat after the tab reports "complete").
function sendToContent(tabId, message, attempt = 0) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      const err = chrome.runtime.lastError;
      if (err) {
        if (attempt < 25) {
          setTimeout(() => sendToContent(tabId, message, attempt + 1).then(resolve, reject), 400);
        } else {
          reject(new Error('content script not reachable: ' + err.message));
        }
        return;
      }
      resolve(response);
    });
  });
}

chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEPALIVE_ALARM) connect();
});
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);

// Connect as soon as the worker spins up.
connect();
