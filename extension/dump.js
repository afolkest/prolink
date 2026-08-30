// Endpoint-backed conversation dump helpers for the prolink service worker.
// Kept in a separate classic script so Node tests can exercise endpoint/auth
// behavior without loading the Chrome extension runtime.
(() => {
  const CHATGPT_ORIGIN = 'https://chatgpt.com';

  function conversationEndpointId(conversation) {
    if (typeof conversation !== 'string' || !conversation) throw new Error('missing conversation id');
    if (conversation.includes('..') || conversation.includes('//') || conversation.includes('\\') || /[?#\s]/.test(conversation)) {
      throw new Error(`invalid conversation id ${JSON.stringify(conversation)}`);
    }
    const parts = conversation.split('/').filter(Boolean);
    if (parts.length === 1) return parts[0];
    const c = parts.lastIndexOf('c');
    if (c >= 0 && c === parts.length - 2 && parts[c + 1]) return parts[c + 1];
    throw new Error(`invalid conversation id ${JSON.stringify(conversation)}`);
  }

  async function responseText(res) {
    try { return (await res.text()).replace(/\s+/g, ' ').trim().slice(0, 500); }
    catch { return ''; }
  }

  async function responseJson(res) {
    try { return await res.json(); }
    catch { throw new Error('ChatGPT conversation endpoint returned malformed JSON'); }
  }

  async function fetchAccessToken({ fetchImpl = fetch, signal } = {}) {
    try {
      const res = await fetchImpl(`${CHATGPT_ORIGIN}/api/auth/session`, {
        method: 'GET',
        credentials: 'include',
        headers: { accept: 'application/json' },
        signal,
      });
      if (!res || !res.ok) return '';
      const data = await res.json().catch(() => null);
      const token = data && (data.accessToken || data.access_token || data.token);
      return typeof token === 'string' ? token : '';
    } catch {
      // Cookie-only conversation fetch may still work; surface auth failures from
      // the authoritative conversation endpoint instead of the optional session read.
      return '';
    }
  }

  async function fetchConversationJson(conversation, { timeoutMs = 60_000, fetchImpl = fetch } = {}) {
    const endpointId = conversationEndpointId(conversation);
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller && Number.isFinite(timeoutMs) && timeoutMs > 0
      ? setTimeout(() => controller.abort(), timeoutMs)
      : null;

    try {
      const token = await fetchAccessToken({ fetchImpl, signal: controller && controller.signal });
      const fetchEndpoint = (bearer) => {
        const headers = { accept: 'application/json' };
        if (bearer) headers.authorization = `Bearer ${bearer}`;
        return fetchImpl(`${CHATGPT_ORIGIN}/backend-api/conversation/${encodeURIComponent(endpointId)}`, {
          method: 'GET',
          credentials: 'include',
          headers,
          signal: controller && controller.signal,
        });
      };

      let retriedCookieOnly = false;
      let res = await fetchEndpoint(token);
      if (token && res && (res.status === 401 || res.status === 403)) {
        // A stale bearer token can make an otherwise-valid cookie session fail;
        // retry once with credentials-only before surfacing the auth error.
        retriedCookieOnly = true;
        res = await fetchEndpoint('');
      }

      if (!res || !res.ok) {
        const status = res && res.status ? res.status : 'unknown';
        const detail = res ? await responseText(res) : '';
        if (status === 401 || status === 403) {
          const mode = token
            ? (retriedCookieOnly ? 'bearer-token and cookie-only auth were both rejected' : 'the bearer-token session was rejected')
            : 'no access token was available and cookie-only auth was rejected';
          throw new Error(`ChatGPT authentication failed while fetching conversation (HTTP ${status}; ${mode}). Make sure you are logged into chatgpt.com in this Chrome profile.`);
        }
        if (status === 404) {
          throw new Error(`Conversation ${JSON.stringify(conversation)} was not found or is not accessible (HTTP 404).`);
        }
        throw new Error(`ChatGPT conversation endpoint returned HTTP ${status}${detail ? `: ${detail}` : ''}`);
      }

      const data = await responseJson(res);
      if (!data || typeof data !== 'object' || Array.isArray(data) || !data.mapping || typeof data.mapping !== 'object' || Array.isArray(data.mapping)) {
        throw new Error('ChatGPT conversation endpoint returned unexpected JSON (missing conversation mapping).');
      }
      if (!data.conversation_id) data.conversation_id = endpointId;
      return data;
    } catch (e) {
      if (e && e.name === 'AbortError') throw new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s fetching conversation from ChatGPT.`);
      throw e;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  globalThis.prolinkDump = { conversationEndpointId, fetchAccessToken, fetchConversationJson };
})();
