// Shared CLI defaults. The extension has its own copy of the port in
// extension/background.js — keep them in sync if you change it.
export const CONFIG = {
  host: '127.0.0.1',
  port: 8767,

  // Shared secret for the local WebSocket bridge. The CLI and the extension
  // must each present this token before acting on the other's messages. The
  // server also stays silent until the client proves the token, so a stray
  // local client can't lift a prompt/response or spoof a result.
  //
  // Scope of protection (it is NOT airtight): combined with the verifyClient
  // origin check this fully blocks web pages (they can't read the token and
  // can't bind a local port). It does NOT stop a local process that can read
  // these files, nor one that squats the bridge port (the extension reveals
  // the token when it connects). Closing that last gap needs an HMAC
  // challenge-response handshake (deferred — token never sent in the clear).
  // For more isolation today, set PROLINK_TOKEN in your shell AND change
  // BRIDGE_TOKEN in extension/background.js to the same value.
  token: process.env.PROLINK_TOKEN || 'pl_3f9c1a7e8b2d4654a1c0e5f6079b8d2c',

  // How long the CLI waits for the extension's service worker to connect.
  // After a long idle, an MV3 service worker is asleep and only revived by
  // its keepalive alarm (~every 30s), so allow for that on a cold start.
  connectTimeoutMs: 40_000,

  // Default upper bound for `--wait` and conversation endpoint operations.
  // Submission itself returns as soon as ChatGPT assigns a conversation and
  // user-message id. Higher effort levels can generate for a long time, so the
  // later polling cap is intentionally generous.
  responseTimeoutMs: 120 * 60_000, // 2 hours

  // ChatGPT exposes the model and its reasoning effort as separate controls.
  // Labels are matched case-insensitively against the current picker. Set both
  // to '' (or pass --no-model) to leave the page defaults unchanged.
  defaultModel: '5.6 Sol',
  defaultEffort: 'Medium',
};
