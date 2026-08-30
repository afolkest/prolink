// prolink content script — runs inside chatgpt.com.
//
// Receives a {prompt, model, effort} job from the service worker, drives the
// page (pick model + effort -> type -> send), and returns as soon as ChatGPT
// exposes the accepted conversation id + user-message id. Response generation
// is polled separately through ChatGPT's conversation endpoint.
//
// Selectors are centralized here because they are the thing most likely to
// drift when ChatGPT reskins. If something stops working, this is the file to
// patch. Verified against chatgpt.com selectors current as of August 2026.
(() => {
  const SEL = {
    composer: '#prompt-textarea',
    send: 'button[data-testid="send-button"]',
    user: 'div[data-message-author-role="user"]',
    // The model picker lives as a "pill" button inside the composer. Its menu
    // contains model radio items and a separate reasoning-effort slider.
    modelButton: [
      '[data-testid="model-switcher-dropdown-button"]',
      'button.__composer-pill[aria-haspopup="menu"]',
    ],
    // Used only as a fallback to distinguish the picker from the "+" button.
    modelLevelRe: /\b(default|gpt[- ]?\d|\d+\.\d+\s+(sol|terra|luna)|instant|medium|high|extra\s*high|pro|thinking|auto|select\s+effort)\b/i,
    menu: '[data-testid="composer-intelligence-picker-content"], [role="menu"], [role="listbox"], [data-radix-collection-root]',
    menuItem: '[role="menuitemradio"], [role="menuitem"], [role="option"], [data-composer-intelligence-pro-effort-action], [data-model-picker-thinking-effort-action]',
    effortView: '[data-testid="composer-model-picker-slider-simple-view"]',
    effortSlider: '[role="slider"]',
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (sel) => document.querySelector(sel);
  const norm = (s) => (s || '').toLowerCase().replace(/\s+/g, ' ').trim();

  // ChatGPT's menus are Radix-style: the trigger opens on *pointerdown*, not a
  // bare click, so element.click() won't open them. Replay a full pointer
  // sequence to mimic a real mouse click.
  function realClick(el) {
    el.focus?.();
    const common = { bubbles: true, cancelable: true, view: window };
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      const ev = type.startsWith('pointer') && window.PointerEvent
        ? new PointerEvent(type, { ...common, pointerId: 1, pointerType: 'mouse' })
        : new MouseEvent(type, common);
      el.dispatchEvent(ev);
    }
  }

  async function waitFor(selOrFn, { timeout = 15_000, interval = 150 } = {}) {
    const test = typeof selOrFn === 'function' ? selOrFn : () => $(selOrFn);
    const start = Date.now();
    for (;;) {
      const el = test();
      if (el) return el;
      if (Date.now() - start > timeout) return null;
      await sleep(interval);
    }
  }

  // On failure, capture enough of the live DOM to fix the selectors without a
  // browser round-trip. Returned via the bridge and printed by the CLI.
  function collectModelDiag() {
    const lines = [];
    const txt = (el) => (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 45);
    lines.push('CANDIDATE CHECK:');
    for (const s of SEL.modelButton) {
      const el = $(s);
      lines.push(`  ${s} => ${el ? 'FOUND <' + el.tagName.toLowerCase() + '> ' + txt(el) : 'none'}`);
    }
    lines.push('ALL <button> (idx | testid | aria-label | haspopup | text):');
    [...document.querySelectorAll('button')].forEach((b, i) => {
      lines.push(`  [${i}] ${b.getAttribute('data-testid') || '-'} | ${b.getAttribute('aria-label') || '-'} | ${b.getAttribute('aria-haspopup') || '-'} | ${txt(b)}`);
    });
    lines.push('ELEMENTS WITH aria-haspopup:');
    [...document.querySelectorAll('[aria-haspopup]')].forEach((el) => {
      lines.push(`  <${el.tagName.toLowerCase()} testid=${el.getAttribute('data-testid') || '-'} label=${el.getAttribute('aria-label') || '-'}> ${txt(el)}`);
    });
    lines.push('ELEMENTS WITH testid containing "model":');
    [...document.querySelectorAll('[data-testid*="model" i]')].forEach((el) => {
      lines.push(`  <${el.tagName.toLowerCase()} testid=${el.getAttribute('data-testid')}> ${txt(el)}`);
    });
    const openMenu = findPickerMenu();
    lines.push('OPEN MENU: ' + (openMenu ? 'yes' : 'no'));
    if (openMenu) {
      lines.push('MENU ITEMS:');
      [...openMenu.querySelectorAll('[role="menuitem"],[role="menuitemradio"],[role="option"],button,a')].forEach((el) => {
        lines.push(`  <${el.tagName.toLowerCase()} role=${el.getAttribute('role') || '-'} testid=${el.getAttribute('data-testid') || '-'}> ${txt(el)}`);
      });
      const view = activeEffortView();
      const slider = view && view.querySelector(SEL.effortSlider);
      lines.push(`EFFORT SLIDER: ${slider ? `value=${slider.getAttribute('aria-valuenow') || '-'} text=${txt(view)}` : `none${view ? ` (view text=${txt(view)})` : ''}`}`);
    }
    const counts = {};
    document.querySelectorAll('[role]').forEach((el) => {
      const r = el.getAttribute('role');
      counts[r] = (counts[r] || 0) + 1;
    });
    lines.push('ROLES PRESENT: ' + JSON.stringify(counts));
    return lines.join('\n');
  }

  function findModelButton() {
    // Explicit selectors first.
    for (const s of SEL.modelButton) { const el = $(s); if (el) return el; }
    // Otherwise: the composer pill is a menu-button whose visible label is an
    // current model/effort. Exclude the "+" add-files button.
    const btns = [...document.querySelectorAll('button[aria-haspopup="menu"]')];
    return btns.find((b) =>
      b.getAttribute('data-testid') !== 'composer-plus-btn' &&
      SEL.modelLevelRe.test((b.textContent || '').trim())
    ) || null;
  }

  function isVisible(el) {
    return !!(el && el.isConnected && (el.getClientRects().length || el.offsetParent !== null));
  }

  function findPickerMenu() {
    const roleMenu = [...document.querySelectorAll('[role="menu"]')].find((el) =>
      isVisible(el) && (el.querySelector('[role="menuitemradio"]') || el.querySelector(SEL.effortView))
    );
    if (roleMenu) return roleMenu;
    return [...document.querySelectorAll(SEL.menu)].find((el) =>
      isVisible(el) && (el.querySelector('[role="menuitemradio"]') || el.querySelector(SEL.effortSlider))
    ) || null;
  }

  async function openPicker() {
    const alreadyOpen = findPickerMenu();
    if (alreadyOpen) return alreadyOpen;
    // A fresh Work tab can expose its composer well before the model pill
    // finishes hydrating, so give the picker its own longer readiness window.
    const btn = await waitFor(() => findModelButton(), { timeout: 30_000 });
    if (!btn) return null;
    realClick(btn);
    return waitFor(() => findPickerMenu(), { timeout: 4000 });
  }

  function modelItems(menu) {
    const radios = [...menu.querySelectorAll('[role="menuitemradio"]')];
    if (radios.length) return radios;
    let items = [...menu.querySelectorAll(SEL.menuItem)];
    if (!items.length) items = [...menu.querySelectorAll('button, a')];
    return items.filter((el) => !el.matches(SEL.effortSlider));
  }

  function canonicalModelLabel(value) {
    return norm(value).replace(/^gpt[\s-]*/, '');
  }

  function findModelChoice(items, target) {
    const want = canonicalModelLabel(target);
    const labels = items.map((el) => canonicalModelLabel(el.innerText || el.textContent || ''));
    let index = labels.findIndex((label) => label === want);
    if (index < 0) index = labels.findIndex((label) => label.startsWith(`${want} `));
    return index < 0 ? null : items[index];
  }

  async function selectModel(target) {
    if (!target) return { ok: true };
    const menu = await openPicker();
    if (!menu) return { ok: false, error: 'model picker (composer pill) did not open', diag: collectModelDiag() };
    await sleep(150);

    const items = modelItems(menu);
    const match = findModelChoice(items, target);
    const options = items.map((el) => (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim()).filter(Boolean);
    if (!match) {
      const diag = collectModelDiag();
      document.body.click();
      return { ok: false, error: `model "${target}" not found in picker`, options, diag };
    }

    if (match.getAttribute('aria-checked') !== 'true') {
      // The current picker keeps the model radios mounted in an inert advanced
      // view until "Select model" is opened. Activate that view before clicking.
      if (match.closest('[inert]')) {
        const toggle = menu.querySelector('[role="menuitem"][aria-label="Select model"]');
        if (!toggle) return { ok: false, error: 'model list toggle not found', options, diag: collectModelDiag() };
        realClick(toggle);
        await sleep(200);
      }
      const liveMenu = await openPicker();
      const liveMatch = liveMenu && findModelChoice(modelItems(liveMenu), target);
      if (!liveMatch || liveMatch.closest('[inert]')) {
        return { ok: false, error: `model list did not open for "${target}"`, options, diag: collectModelDiag() };
      }
      realClick(liveMatch);
      await sleep(300);
    }

    // Re-open if choosing a model dismissed the menu, then verify the radio
    // selection before allowing the prompt to be submitted.
    const verifyMenu = await openPicker();
    const selected = verifyMenu && modelItems(verifyMenu).find((el) => el.getAttribute('aria-checked') === 'true');
    if (!selected || canonicalModelLabel(selected.innerText || selected.textContent || '') !== canonicalModelLabel(target)) {
      return { ok: false, error: `model "${target}" did not become selected`, options, diag: collectModelDiag() };
    }
    return { ok: true };
  }

  function activeEffortView() {
    return [...document.querySelectorAll(SEL.effortView)].find((el) =>
      isVisible(el) && el.getAttribute('data-active') !== 'false'
    ) || null;
  }

  function effortSliderState() {
    const slider = activeEffortView()?.querySelector(SEL.effortSlider);
    return slider && slider.getAttribute('aria-valuenow') || '';
  }

  function effortKeyboardControl(view = activeEffortView()) {
    if (!view) return null;
    return view.querySelector('[role="menuitem"][aria-keyshortcuts*="ArrowLeft"]')
      || view.querySelector('[role="menuitem"][aria-label="Power"]')
      || view.querySelector('[data-model-reasoning-effort-slider]')?.closest('[role="menuitem"]')
      || view.querySelector(SEL.effortSlider);
  }

  function effortLabel() {
    const view = activeEffortView();
    const slider = view && view.querySelector(SEL.effortSlider);
    const text = (view && view.textContent || slider && slider.getAttribute('aria-valuetext') || '').replace(/\s+/g, ' ').trim();
    const match = text.match(/^(.+?),\s*\d+\s+of\s+\d+/i);
    return (match ? match[1] : text.split(',')[0]).trim();
  }

  async function moveEffort(key) {
    await openPicker();
    const view = activeEffortView();
    const target = effortKeyboardControl(view);
    if (!target) return false;
    target.focus();
    const keyCode = key === 'ArrowLeft' ? 37 : 39;
    for (const type of ['keydown', 'keyup']) {
      const event = new KeyboardEvent(type, { key, code: key, keyCode, which: keyCode, bubbles: true, cancelable: true });
      target.dispatchEvent(event);
    }
    await sleep(140);
    return true;
  }

  async function selectEffort(target) {
    if (!target) return { ok: true };
    let menu = await openPicker();
    if (!menu) return { ok: false, error: 'model/effort picker (composer pill) did not open', diag: collectModelDiag() };
    const want = norm(target);
    const seen = [];
    const remember = (label) => { if (label && !seen.some((s) => norm(s) === norm(label))) seen.push(label); };
    let label = effortLabel();
    remember(label);
    if (norm(label) === want) return { ok: true };
    if (!effortKeyboardControl()) {
      return { ok: false, error: 'reasoning-effort keyboard control not found in picker', diag: collectModelDiag() };
    }

    // Discover the live slider rather than hard-coding positions: walk to the
    // left edge, then walk right until the requested visible label appears.
    for (let i = 0; i < 12; i++) {
      const before = `${norm(label)}:${effortSliderState()}`;
      if (!await moveEffort('ArrowLeft')) break;
      menu = await openPicker();
      label = effortLabel();
      remember(label);
      const after = `${norm(label)}:${effortSliderState()}`;
      if (after === before) break;
    }

    for (let i = 0; i < 12; i++) {
      label = effortLabel();
      remember(label);
      if (norm(label) === want) return { ok: true };
      const before = `${norm(label)}:${effortSliderState()}`;
      if (!await moveEffort('ArrowRight')) break;
      menu = await openPicker();
      label = effortLabel();
      remember(label);
      const after = `${norm(label)}:${effortSliderState()}`;
      if (norm(label) === want) return { ok: true };
      if (after === before) break;
    }

    return { ok: false, error: `effort "${target}" not found on slider`, options: seen, diag: collectModelDiag() };
  }

  async function selectModelAndEffort(model, effort) {
    const pickedModel = await selectModel(model);
    if (!pickedModel.ok) return pickedModel;
    const pickedEffort = await selectEffort(effort);
    if (!pickedEffort.ok) return pickedEffort;
    const composer = $(SEL.composer);
    if (composer) realClick(composer); else document.body.click();
    await sleep(100);
    return { ok: true };
  }

  async function setComposerText(text) {
    const el = await waitFor(SEL.composer, { timeout: 20_000 });
    if (!el) throw new Error('composer (#prompt-textarea) not found');
    el.focus();

    // ChatGPT's composer is a ProseMirror contenteditable, so setting .value
    // does nothing — insert via execCommand so React/ProseMirror register it.
    try {
      const selection = window.getSelection();
      selection.removeAllRanges();
      const range = document.createRange();
      range.selectNodeContents(el);
      selection.addRange(range);
      document.execCommand('insertText', false, text);
    } catch {
      // Fallback: build paragraphs and fire an input event.
      el.innerHTML = '';
      for (const line of text.split('\n')) {
        const p = document.createElement('p');
        p.textContent = line;
        el.appendChild(p);
      }
      el.dispatchEvent(new InputEvent('input', { bubbles: true }));
    }
    await sleep(150); // let the send button enable
  }

  async function clickSend() {
    const btn = await waitFor(() => {
      const b = $(SEL.send);
      return b && !b.disabled ? b : null;
    }, { timeout: 10_000 });
    if (!btn) throw new Error('send button not found or stayed disabled');
    btn.click();
  }

  // Keep only the short submission transaction durable. Once ChatGPT has
  // accepted the user message we store its conversation/message identity and
  // return immediately; response generation and result reads happen later via
  // the conversation endpoint, not through this page or message channel.
  const SUBMIT_PREFIX = 'prolink-submit-'; // keep in sync with background.js
  function loadSubmit(id) {
    return new Promise((resolve) => {
      try {
        chrome.storage.session.get(SUBMIT_PREFIX + id, (o) => {
          if (chrome.runtime.lastError) { resolve({ ok: false }); return; }
          resolve({ ok: true, state: (o && o[SUBMIT_PREFIX + id]) || null });
        });
      } catch { resolve({ ok: false }); }
    });
  }
  function saveSubmit(id, state) {
    return new Promise((resolve) => {
      try {
        chrome.storage.session.set({ [SUBMIT_PREFIX + id]: state }, () => resolve(!chrome.runtime.lastError));
      } catch { resolve(false); }
    });
  }

  // The conversation handle lives in the URL once ChatGPT has created the thread.
  // A plain chat is /c/<uuid> (we return the bare id for a clean handle); a
  // GPT/Project chat is /g/<gizmo>/c/<uuid> (we return the whole path so the CLI
  // can return to the *right* thread — dropping the /g/ prefix would silently
  // open a new chat). Read it after submission so the CLI can continue with -c.
  function currentConversationId() {
    const path = location.pathname;
    const g = path.match(/\/(g\/[^/?#]+\/c\/[^/?#]+)/);
    if (g) return g[1];
    const c = path.match(/\/c\/([^/?#]+)/);
    return c ? c[1] : '';
  }

  // New Work chats briefly use client-side handles such as WEB:<uuid> before
  // ChatGPT replaces the URL with the canonical conversation id accepted by
  // its conversation endpoint. Never persist or return that transient handle.
  function finalizedConversationId() {
    const id = currentConversationId();
    return id && !/^[A-Za-z]+:/.test(id) ? id : '';
  }

  function snapshotLastUser() {
    const nodes = document.querySelectorAll(SEL.user);
    const last = nodes[nodes.length - 1];
    return {
      hadUser: !!last,
      id: last ? (last.getAttribute('data-message-id') || '') : '',
      node: last || null,
    };
  }

  async function waitForSubmission(previous, expectedConversation, timeoutMs) {
    const submittedUser = await waitFor(() => {
      const nodes = document.querySelectorAll(SEL.user);
      const last = nodes[nodes.length - 1];
      if (!last) return null;
      const id = last.getAttribute('data-message-id') || '';
      if (!id) return null;
      if (!previous.hadUser) return last;
      if (last !== previous.node || id !== previous.id) return last;
      return null;
    }, { timeout: Math.min(timeoutMs || 30_000, 30_000), interval: 100 });
    if (!submittedUser) throw new Error('submitted user message was not acknowledged by ChatGPT');

    const conversation = await waitFor(() => finalizedConversationId() || null, {
      timeout: Math.min(timeoutMs || 30_000, 30_000),
      interval: 100,
    });
    if (!conversation) throw new Error('ChatGPT accepted the message but did not finalize its conversation id');
    if (expectedConversation && conversation !== expectedConversation) {
      throw new Error(`conversation changed while submitting (expected ${JSON.stringify(expectedConversation)}, got ${JSON.stringify(conversation)})`);
    }
    return {
      conversation,
      userMessageId: submittedUser.getAttribute('data-message-id') || '',
    };
  }

  async function run({ id, prompt, model, effort, timeoutMs, conversation: expectedConversation }) {
    // Confirm we're actually on a usable, logged-in chat page first.
    const ready = await waitFor(SEL.composer, { timeout: 20_000 });
    if (!ready) {
      return { ok: false, error: 'ChatGPT composer never appeared (not logged in, or page blocked?)' };
    }

    // If a previous content-script instance already submitted this short
    // transaction, replay its acknowledgement instead of clicking again. If a
    // prior attempt was interrupted mid-click, report the ambiguity.
    const read = await loadSubmit(id);
    if (!read.ok) {
      // Fail closed: if we can't read durable submit-state we can't rule out a
      // prior submit, so submitting could double-post. (The worker grants
      // content scripts storage access; this should only happen on very old
      // Chrome without storage.session.setAccessLevel.)
      return { ok: false, error: 'durable de-dup unavailable (could not read submit state) — refusing to submit to avoid a double post' };
    }
    const prior = read.state;
    if (prior && prior.phase === 'submitting') {
      return { ok: false, error: 'a previous submit for this run was interrupted; not retrying to avoid double-posting. The earlier chat tab may or may not already contain this prompt — check/close it, then run prolink again for a fresh chat.' };
    }
    if (prior && prior.phase === 'submitted' && prior.conversation && prior.userMessageId) {
      return { ok: true, conversation: prior.conversation, userMessageId: prior.userMessageId, reattached: true };
    }
    if (prior && prior.phase === 'submitted') {
      return { ok: false, error: 'this job was submitted by an older prolink extension that did not record its message identity; refusing to submit it again. Inspect the existing chat tab and start a new job if needed.' };
    }

    const loadedConversation = currentConversationId();
    if (expectedConversation && loadedConversation !== expectedConversation) {
      return { ok: false, error: `requested conversation did not load (expected ${JSON.stringify(expectedConversation)}, got ${JSON.stringify(loadedConversation)})` };
    }
    if (!expectedConversation && loadedConversation) {
      return { ok: false, error: `new-chat tab unexpectedly loaded conversation ${JSON.stringify(loadedConversation)} — refusing to submit` };
    }

    const picked = await selectModelAndEffort(model, effort);
    if (!picked.ok) return picked;
    const previous = snapshotLastUser();
    await setComposerText(prompt);
    const marked = await saveSubmit(id, { phase: 'submitting' });
    if (!marked) {
      return { ok: false, error: 'could not persist the short submit transaction — refusing to click Send' };
    }
    await clickSend();
    const submitted = await waitForSubmission(previous, expectedConversation || '', timeoutMs);
    await saveSubmit(id, { phase: 'submitted', ...submitted });
    return { ok: true, ...submitted };
  }

  // In-instance de-dup by job id. The service worker can be killed mid-run and
  // revived, at which point it re-sends the same job. We must not start it twice
  // (that would submit the prompt twice), so we attach to the in-flight run, or
  // replay the finished result, for an id we've already seen. This map lives in
  // page memory, so it does NOT survive a page reload — the durable guard for
  // that is loadSubmit/saveSubmit inside run().
  const jobs = new Map(); // id -> Promise<response>
  let lastFinished = null; // { id, response }

  function startOrAttach(id, prompt, model, effort, timeoutMs, conversation) {
    if (jobs.has(id)) return jobs.get(id);
    if (lastFinished && lastFinished.id === id) return Promise.resolve(lastFinished.response);
    const p = run({ id, prompt, model, effort, timeoutMs, conversation })
      // Surface the conversation handle even on failure (e.g. a timeout after the
      // chat was already created), so the CLI can still report/continue it.
      .catch((e) => ({ ok: false, error: String((e && e.message) || e), conversation: currentConversationId() }))
      .then((response) => {
        lastFinished = { id, response };
        jobs.delete(id);
        return response;
      });
    jobs.set(id, p);
    return p;
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === 'run' && msg.id) {
      startOrAttach(msg.id, msg.prompt, msg.model, msg.effort, msg.timeoutMs, msg.conversation || '').then(sendResponse);
      return true; // keep the channel open for the async response
    }
  });
})();
