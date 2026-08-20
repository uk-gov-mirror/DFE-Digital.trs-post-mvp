(function () {
  const STORAGE_KEY = 'designReview_v1';
  /** @type {string} Local profile for display name, email (future notifications). */
  const USER_PROFILE_KEY = 'designReview_user_v1';
  const HOST_ID = 'design-review-extension-root';

  /** @type {{ displayName: string, email: string }} */
  let cachedUserProfile = { displayName: '', email: '' };

  if (window.__designReviewExtensionLoaded) return;
  window.__designReviewExtensionLoaded = true;

  /** @type {ReturnType<typeof setInterval> | null} */
  let remotePollTimer = null;

  function supabaseConfig() {
    try {
      if (typeof DESIGN_REVIEW_SUPABASE === 'undefined') return null;
      const url = String(DESIGN_REVIEW_SUPABASE.url || '').trim();
      const anonKey = String(DESIGN_REVIEW_SUPABASE.anonKey || '').trim();
      if (!url || !anonKey) return null;
      return { url: url.replace(/\/$/, ''), anonKey };
    } catch {
      return null;
    }
  }

  async function loadUserProfileFromStorage() {
    try {
      const raw = await chrome.storage.local.get(USER_PROFILE_KEY);
      const p = raw[USER_PROFILE_KEY];
      if (p && typeof p === 'object') {
        cachedUserProfile = {
          displayName: String(p.displayName || '').trim(),
          email: String(p.email || '').trim(),
        };
      } else {
        cachedUserProfile = { displayName: '', email: '' };
      }
    } catch {
      cachedUserProfile = { displayName: '', email: '' };
    }
  }

  /**
   * Name on new comments; avatar initial is the first character.
   * Order: saved profile, optional config fallback, then "You".
   */
  function reviewerDisplayName() {
    if (cachedUserProfile.displayName) return cachedUserProfile.displayName;
    try {
      if (typeof DESIGN_REVIEW_SUPABASE !== 'undefined') {
        const n = String(DESIGN_REVIEW_SUPABASE.displayName || '').trim();
        if (n) return n;
      }
    } catch {
      /* ignore */
    }
    return 'You';
  }

  /**
   * @param {{ displayName: string, email: string }} profile
   */
  async function saveUserProfile(profile) {
    const displayName = String(profile.displayName || '').trim();
    const email = String(profile.email || '').trim();
    const payload = {
      [USER_PROFILE_KEY]: {
        displayName,
        email,
        updatedAt: Date.now(),
      },
    };
    await chrome.storage.local.set(payload);
    cachedUserProfile = { displayName, email };
  }

  function stopRemotePoll() {
    if (remotePollTimer) {
      clearInterval(remotePollTimer);
      remotePollTimer = null;
    }
  }

  function startRemotePoll() {
    stopRemotePoll();
    if (!supabaseConfig()) return;
    remotePollTimer = setInterval(() => {
      void refreshFromRemote();
    }, 12_000);
  }

  async function fetchThreadsFromSupabase(pageKeyValue) {
    const cfg = supabaseConfig();
    if (!cfg) throw new Error('Supabase not configured');
    const encoded = encodeURIComponent(pageKeyValue);
    const res = await fetch(
      `${cfg.url}/rest/v1/design_review_pages?select=threads&page_key=eq.${encoded}&limit=1`,
      {
        method: 'GET',
        headers: {
          apikey: cfg.anonKey,
          Authorization: `Bearer ${cfg.anonKey}`,
          Accept: 'application/json',
        },
      },
    );
    if (!res.ok) {
      const err = await res.text();
      throw new Error(err || res.statusText);
    }
    const rows = await res.json();
    if (!Array.isArray(rows) || rows.length === 0) return [];
    const t = rows[0]?.threads;
    return Array.isArray(t) ? t : [];
  }

  async function upsertThreadsToSupabase(pageKeyValue, threads) {
    const cfg = supabaseConfig();
    if (!cfg) throw new Error('Supabase not configured');
    const res = await fetch(`${cfg.url}/rest/v1/design_review_pages`, {
      method: 'POST',
      headers: {
        apikey: cfg.anonKey,
        Authorization: `Bearer ${cfg.anonKey}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates',
      },
      body: JSON.stringify({ page_key: pageKeyValue, threads }),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(err || res.statusText);
    }
  }

  /** @type {{ reviewMode: boolean, selectedThreadId: string | null }} */
  const state = {
    reviewMode: false,
    selectedThreadId: null,
  };

  function pageKey() {
    const u = new URL(location.href);
    return `${u.origin}${u.pathname}${u.search}`;
  }

  function uuid() {
    return crypto.randomUUID();
  }

  function buildSelector(el) {
    if (!el || el.nodeType !== 1) return 'body';
    if (el.id) return `#${CSS.escape(el.id)}`;
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && cur !== document.documentElement) {
      let part = cur.tagName.toLowerCase();
      const parent = cur.parentElement;
      if (cur.id) {
        parts.unshift(`#${CSS.escape(cur.id)}`);
        break;
      }
      if (parent) {
        const sameTag = [...parent.children].filter((c) => c.tagName === cur.tagName);
        if (sameTag.length > 1) {
          const index = sameTag.indexOf(cur) + 1;
          part += `:nth-of-type(${index})`;
        }
      }
      parts.unshift(part);
      cur = parent;
    }
    return parts.join(' > ') || 'body';
  }

  function elementFromSelector(selector) {
    try {
      return document.querySelector(selector);
    } catch {
      return null;
    }
  }

  /**
   * The full-screen overlay sits above the page. elementFromPoint hits that layer first.
   * Walk the hit-test stack and skip every node that lives in our extension shadow root.
   */
  function topPageElementUnderPoint(clientX, clientY) {
    const host = document.getElementById(HOST_ID);
    const stack = document.elementsFromPoint(clientX, clientY);
    for (const n of stack) {
      if (!(n instanceof Element)) continue;
      const root = n.getRootNode();
      if (host && root instanceof ShadowRoot && root.host === host) {
        continue;
      }
      if (host && n === host) {
        continue;
      }
      return n;
    }
    return null;
  }

  function avatarInitial(author) {
    const t = String(author || '?').trim();
    if (!t) return '?';
    return t[0].toUpperCase();
  }

  function avatarStyle(author) {
    let h = 0;
    const s = String(author || 'x');
    for (let i = 0; i < s.length; i++) h = (h + s.charCodeAt(i) * 13) % 360;
    return `--dr-h:${h}`;
  }

  function formatRelativeTime(ts) {
    const n = Date.now() - ts;
    if (n < 60_000) return 'just now';
    const m = Math.floor(n / 60_000);
    if (m < 60) return `${m} minute${m === 1 ? '' : 's'} ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`;
    const d = Math.floor(h / 24);
    if (d < 30) return `${d} day${d === 1 ? '' : 's'} ago`;
    try {
      return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    } catch {
      return '';
    }
  }

  function formatCommentBody(raw) {
    const s = String(raw);
    const re = /(https?:\/\/[^\s<]+[^\s<.,;)]|mailto:[^\s]+|[\w.+-]+@[\w.-]+\.[a-zA-Z]{2,})/g;
    const parts = [];
    let last = 0;
    let m;
    while ((m = re.exec(s)) !== null) {
      if (m.index > last) parts.push({ t: 'text', v: s.slice(last, m.index) });
      parts.push({ t: 'link', v: m[0] });
      last = m.index + m[0].length;
    }
    if (last < s.length) parts.push({ t: 'text', v: s.slice(last) });
    return parts
      .map((p) => {
        if (p.t === 'text') {
          return escapeHtml(p.v).replace(/\n/g, '<br>');
        }
        let href = p.v;
        if (!/^https?:\/\//i.test(href) && !/^mailto:/i.test(href)) {
          href = `mailto:${p.v}`;
        }
        return `<a class="dr-link" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(p.v)}</a>`;
      })
      .join('');
  }

  function threadPinLabel(thread) {
    const sorted = [...thread.comments].sort((a, b) => a.createdAt - b.createdAt);
    const first = sorted[0];
    if (first?.author) return avatarInitial(first.author);
    return '+';
  }

  async function loadStore() {
    const raw = await chrome.storage.local.get(STORAGE_KEY);
    return raw[STORAGE_KEY] || { pages: {} };
  }

  async function saveStore(store) {
    await chrome.storage.local.set({ [STORAGE_KEY]: store });
  }

  async function persistLocalPageThreads(pageKeyValue, threads) {
    const store = await loadStore();
    if (!store.pages[pageKeyValue]) store.pages[pageKeyValue] = { threads: [] };
    store.pages[pageKeyValue].threads = threads;
    await saveStore(store);
  }

  async function refreshFromRemote() {
    if (!supabaseConfig()) return;
    try {
      const key = pageKey();
      const fresh = await fetchThreadsFromSupabase(key);
      await persistLocalPageThreads(key, fresh);
      await renderPins();
      if (panelLayer && !panelLayer.classList.contains('dr-hidden')) {
        await syncOpenPanelWithThreads(fresh);
      }
    } catch (e) {
      console.warn('Design review: remote sync failed', e);
    }
  }

  async function syncOpenPanelWithThreads(threads) {
    if (state.selectedThreadId) {
      const t = threads.find((x) => x.id === state.selectedThreadId);
      if (t) openEditorForThread(t, false);
      else {
        state.selectedThreadId = null;
        openListPanel(threads);
      }
      return;
    }
    if (panelLayer.querySelector('#dr-thread-list')) {
      openListPanel(threads);
    }
  }

  async function getThreads() {
    const key = pageKey();
    if (supabaseConfig()) {
      try {
        const threads = await fetchThreadsFromSupabase(key);
        await persistLocalPageThreads(key, threads);
        return threads;
      } catch (e) {
        console.warn('Design review: remote fetch failed, using local cache', e);
      }
    }
    const store = await loadStore();
    return store.pages[key]?.threads || [];
  }

  async function setThreads(threads) {
    const key = pageKey();
    await persistLocalPageThreads(key, threads);
    if (supabaseConfig()) {
      try {
        await upsertThreadsToSupabase(key, threads);
      } catch (e) {
        console.warn('Design review: remote save failed (kept local copy)', e);
      }
    }
  }

  function pinPositionForThread(thread) {
    const a = thread?.anchor;
    if (!a) return { x: 0, y: 0, ok: false };
    const el = elementFromSelector(a.selector);
    if (el) {
      const r = el.getBoundingClientRect();
      const x = r.left + (r.width * a.relX) / 100;
      const y = r.top + (r.height * a.relY) / 100;
      return { x, y, ok: true };
    }
    return {
      x: a.fallbackViewportX ?? 0,
      y: a.fallbackViewportY ?? 0,
      ok: false,
    };
  }

  /** @type {ShadowRoot | null} */
  let shadow = null;
  /** @type {HTMLElement | null} */
  let overlayLayer = null;
  /** @type {HTMLElement | null} */
  let panelLayer = null;
  /** @type {HTMLElement | null} */
  let fab = null;

  function injectShell() {
    const existingHost = document.getElementById(HOST_ID);
    // Closed shadow roots expose shadowRoot as null from outside — re-entry crashed here before.
    if (existingHost?.shadowRoot) {
      shadow = existingHost.shadowRoot;
      overlayLayer = shadow.getElementById('dr-overlay');
      panelLayer = shadow.getElementById('dr-panel-host');
      fab = shadow.getElementById('dr-fab');
      return;
    }
    if (existingHost) {
      existingHost.remove();
    }

    const host = document.createElement('div');
    host.id = HOST_ID;
    host.setAttribute('data-design-review', '');
    document.documentElement.appendChild(host);
    shadow = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = `
      :host { all: initial; }
      *, *::before, *::after { box-sizing: border-box; }
      #dr-fab {
        position: fixed; z-index: 2147483646;
        right: 16px; bottom: 16px;
        font: 600 13px/1 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        padding: 12px 18px;
        border-radius: 999px;
        border: none;
        cursor: pointer;
        background: #18a0fb;
        color: #fff;
        box-shadow: 0 4px 14px rgba(24, 160, 251, 0.45), 0 2px 6px rgba(0,0,0,0.12);
      }
      #dr-fab:hover { filter: brightness(1.05); }
      #dr-fab:focus-visible { outline: 2px solid #0c8ce9; outline-offset: 2px; }
      #dr-fab.active {
        background: #0c8ce9;
        box-shadow: 0 4px 14px rgba(12, 140, 233, 0.5), 0 2px 6px rgba(0,0,0,0.15);
      }
      #dr-overlay {
        position: fixed; inset: 0; z-index: 2147483645;
        pointer-events: none;
      }
      #dr-overlay.review-on { pointer-events: auto; cursor: crosshair; }
      #dr-panel-host {
        position: fixed; z-index: 2147483647;
        right: 16px; top: 16px;
        width: min(400px, calc(100vw - 32px));
        max-height: min(580px, calc(100vh - 32px));
        display: flex; flex-direction: column;
        font: 13px/1.5 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        color: #1e1e1e;
        background: #fff;
        border: none;
        border-radius: 16px;
        box-shadow: 0 12px 48px rgba(0,0,0,0.18), 0 4px 16px rgba(0,0,0,0.08);
        overflow: hidden;
      }
      .dr-figma-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 14px 16px 12px;
        flex-shrink: 0;
      }
      .dr-figma-title {
        margin: 0;
        font-size: 15px;
        font-weight: 600;
        letter-spacing: -0.01em;
        color: #1e1e1e;
      }
      .dr-figma-actions {
        display: flex;
        align-items: center;
        gap: 4px;
        position: relative;
      }
      .dr-icon-btn {
        width: 32px;
        height: 32px;
        padding: 0;
        border: none;
        border-radius: 50%;
        background: transparent;
        color: #5c5c5c;
        font-size: 18px;
        line-height: 1;
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        justify-content: center;
      }
      .dr-icon-btn:hover { background: rgba(0,0,0,0.06); color: #1e1e1e; }
      .dr-icon-btn:focus-visible { outline: 2px solid #18a0fb; outline-offset: 1px; }
      .dr-icon-btn.dr-resolve-on {
        background: rgba(24, 160, 251, 0.15);
        color: #18a0fb;
      }
      .dr-icon-btn.dr-resolve-on:hover { background: rgba(24, 160, 251, 0.22); }
      .dr-more-wrap { position: relative; }
      .dr-more-menu {
        position: absolute;
        top: calc(100% + 6px);
        right: 0;
        min-width: 180px;
        padding: 6px 0;
        background: #3d3d3d;
        border-radius: 8px;
        box-shadow: 0 8px 24px rgba(0,0,0,0.25);
        z-index: 10;
      }
      .dr-more-menu button {
        display: block;
        width: 100%;
        padding: 10px 14px;
        border: none;
        background: none;
        color: #fff;
        font: inherit;
        text-align: left;
        cursor: pointer;
      }
      .dr-more-menu button:hover { background: rgba(255,255,255,0.08); }
      .dr-more-menu button.dr-danger { color: #ff9d9d; }
      .dr-figma-rule {
        height: 1px;
        background: #e8e8e8;
        margin: 0 16px;
        flex-shrink: 0;
      }
      .dr-figma-scroll {
        flex: 1;
        overflow: auto;
        padding: 12px 16px 8px;
        min-height: 0;
      }
      .dr-figma-foot {
        flex-shrink: 0;
        padding: 12px 16px 16px;
        border-top: 1px solid #f0f0f0;
        background: #fff;
      }
      .dr-muted { font-size: 11px; color: #8c8c8c; word-break: break-all; }
      .dr-list-sub { padding: 0 16px 10px; }
      .dr-list-add {
        margin: 0 16px 12px;
        width: calc(100% - 32px);
        padding: 10px 16px;
        border: none;
        border-radius: 10px;
        background: #18a0fb;
        color: #fff;
        font: 600 13px system-ui, sans-serif;
        cursor: pointer;
      }
      .dr-list-add:hover { filter: brightness(1.05); }
      .dr-thread-item {
        margin: 0 16px 10px;
        padding: 12px 14px;
        border-radius: 12px;
        background: #f7f7f7;
        cursor: pointer;
        border: 1px solid transparent;
        transition: border-color 0.15s, background 0.15s;
      }
      .dr-thread-item:hover { background: #f0f0f0; border-color: #e0e0e0; }
      .dr-thread-item.resolved { opacity: 0.72; }
      .dr-thread-item-preview { font-size: 13px; color: #333; margin-top: 4px; line-height: 1.45; }
      .dr-thread-badge {
        font-size: 11px;
        font-weight: 600;
        color: #8c8c8c;
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .dr-avatar {
        width: 36px;
        height: 36px;
        border-radius: 50%;
        flex-shrink: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 14px;
        font-weight: 600;
        color: #fff;
        background: hsl(var(--dr-h, 142), 55%, 42%);
      }
      .dr-avatar.sm { width: 28px; height: 28px; font-size: 12px; }
      .dr-cmt-row {
        display: flex;
        gap: 12px;
        align-items: flex-start;
        margin-bottom: 12px;
      }
      .dr-cmt-row:last-child { margin-bottom: 0; }
      .dr-cmt-thread-group {
        margin-bottom: 8px;
      }
      .dr-cmt-thread-group:last-child {
        margin-bottom: 0;
      }
      /* Align reply rows with the root comment’s text column (small avatar 28px + 12px gap). */
      .dr-cmt-replies-flat {
        display: flex;
        flex-direction: column;
        margin: 0 0 4px 0;
        padding: 0 0 0 40px;
      }
      .dr-cmt-reply-flat {
        margin-bottom: 12px;
      }
      .dr-cmt-replies-flat .dr-cmt-reply-flat:last-child {
        margin-bottom: 0;
      }
      .dr-cmt-main { flex: 1; min-width: 0; }
      .dr-cmt-head {
        display: flex;
        align-items: baseline;
        flex-wrap: wrap;
        gap: 6px 10px;
        margin-bottom: 4px;
      }
      .dr-cmt-name { font-weight: 600; font-size: 13px; color: #1e1e1e; }
      .dr-cmt-time { font-size: 12px; color: #8c8c8c; }
      .dr-cmt-body {
        font-size: 13px;
        color: #333;
        line-height: 1.5;
        word-wrap: break-word;
      }
      .dr-cmt-body .dr-link { color: #18a0fb; text-decoration: none; }
      .dr-cmt-body .dr-link:hover { text-decoration: underline; }
      .dr-reply-inline { margin-top: 10px; }
      .dr-pill-wrap {
        display: flex;
        align-items: flex-end;
        gap: 8px;
        background: #f3f3f3;
        border-radius: 999px;
        padding: 6px 6px 6px 14px;
        border: 1px solid transparent;
        transition: border-color 0.15s, background 0.15s;
      }
      .dr-pill-wrap:focus-within {
        background: #fff;
        border-color: #18a0fb;
        box-shadow: 0 0 0 1px #18a0fb;
      }
      .dr-pill-wrap textarea {
        flex: 1;
        border: none;
        background: transparent;
        font: 13px/1.4 system-ui, sans-serif;
        resize: none;
        min-height: 22px;
        max-height: 120px;
        padding: 6px 0;
        margin: 0;
        outline: none;
        color: #1e1e1e;
      }
      .dr-pill-wrap textarea::placeholder { color: #b3b3b3; }
      .dr-send {
        width: 32px;
        height: 32px;
        border: none;
        border-radius: 50%;
        flex-shrink: 0;
        background: #e0e0e0;
        color: #fff;
        cursor: not-allowed;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 16px;
        line-height: 1;
        transition: background 0.15s;
      }
      .dr-send.dr-send-active {
        background: #18a0fb;
        cursor: pointer;
      }
      .dr-send.dr-send-active:hover { filter: brightness(1.05); }
      .dr-btn-text {
        border: none;
        background: none;
        color: #18a0fb;
        font: 600 12px system-ui, sans-serif;
        cursor: pointer;
        padding: 4px 0;
      }
      .dr-btn-text:hover { text-decoration: underline; }
      .dr-pin {
        position: fixed; z-index: 2147483646;
        width: 32px; height: 32px;
        border-radius: 50%;
        background: #18a0fb;
        color: #fff;
        font: 700 12px/32px system-ui, sans-serif;
        text-align: center;
        border: 2px solid #fff;
        box-shadow: 0 2px 10px rgba(0,0,0,0.2);
        cursor: pointer;
        transform: translate(-50%, -50%);
        pointer-events: auto;
      }
      .dr-pin.resolved { background: #8c8c8c; }
      .dr-pin.selected {
        box-shadow: 0 0 0 3px #ffcd29, 0 2px 10px rgba(0,0,0,0.2);
      }
      .dr-empty-hint { font-size: 12px; color: #8c8c8c; margin: 8px 0 0; }
      .dr-profile-form { padding: 0 16px 16px; display: flex; flex-direction: column; gap: 12px; }
      .dr-profile-form label { font-size: 12px; font-weight: 600; color: #5c5c5c; display: block; margin-bottom: 4px; }
      .dr-profile-form input[type="text"],
      .dr-profile-form input[type="email"] {
        width: 100%;
        padding: 10px 12px;
        border: 1px solid #e0e0e0;
        border-radius: 8px;
        font: 13px system-ui, sans-serif;
        color: #1e1e1e;
      }
      .dr-profile-form input:focus {
        outline: 2px solid #18a0fb;
        outline-offset: 0;
        border-color: #18a0fb;
      }
      .dr-profile-form .dr-form-error { font-size: 12px; color: #c62828; margin: 0; }
      .dr-profile-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 4px; }
      .dr-profile-actions button {
        padding: 10px 16px;
        border-radius: 10px;
        font: 600 13px system-ui, sans-serif;
        cursor: pointer;
        border: none;
      }
      .dr-profile-actions .dr-btn-primary {
        background: #18a0fb;
        color: #fff;
      }
      .dr-profile-actions .dr-btn-primary:hover { filter: brightness(1.05); }
      .dr-profile-actions .dr-btn-secondary {
        background: #f0f0f0;
        color: #333;
      }
      .dr-profile-actions .dr-btn-secondary:hover { background: #e5e5e5; }
      .dr-profile-actions .dr-btn-ghost {
        background: transparent;
        color: #8c8c8c;
      }
      .dr-profile-note { font-size: 12px; color: #8c8c8c; margin: 0; line-height: 1.45; }
      .dr-banner-soft {
        margin: 0 16px 10px;
        padding: 10px 12px;
        border-radius: 10px;
        background: #f0f7ff;
        border: 1px solid #cfe8fc;
        font-size: 12px;
        color: #1e4a6e;
        line-height: 1.4;
      }
      .dr-banner-soft button {
        margin-top: 8px;
        padding: 6px 12px;
        border: none;
        border-radius: 8px;
        background: #18a0fb;
        color: #fff;
        font: 600 12px system-ui, sans-serif;
        cursor: pointer;
      }
      .dr-hidden { display: none !important; }
    `;

    overlayLayer = document.createElement('div');
    overlayLayer.id = 'dr-overlay';

    panelLayer = document.createElement('div');
    panelLayer.id = 'dr-panel-host';
    panelLayer.classList.add('dr-hidden');

    fab = document.createElement('button');
    fab.id = 'dr-fab';
    fab.type = 'button';
    fab.textContent = 'Review';
    fab.addEventListener('click', () => toggleReviewMode());

    shadow.append(style, overlayLayer, panelLayer, fab);

    panelLayer.addEventListener('click', (e) => {
      const menu = panelLayer.querySelector('#dr-more-menu');
      const btn = panelLayer.querySelector('#dr-more-btn');
      if (!menu || !btn || menu.classList.contains('dr-hidden')) return;
      if (btn.contains(e.target) || menu.contains(e.target)) return;
      menu.classList.add('dr-hidden');
      btn.setAttribute('aria-expanded', 'false');
    });

    overlayLayer.addEventListener('click', onOverlayClick);

    window.addEventListener(
      'scroll',
      () => {
        renderPins();
      },
      true,
    );
    window.addEventListener('resize', () => renderPins());
  }

  function toggleReviewMode() {
    state.reviewMode = !state.reviewMode;
    overlayLayer.classList.toggle('review-on', state.reviewMode);
    fab.classList.toggle('active', state.reviewMode);
    fab.textContent = state.reviewMode ? 'Review on' : 'Review';
    if (!state.reviewMode) {
      state.selectedThreadId = null;
      hidePanel();
    }
    renderPins();
  }

  async function onOverlayClick(e) {
    if (!state.reviewMode) return;
    e.preventDefault();
    e.stopPropagation();

    const el = topPageElementUnderPoint(e.clientX, e.clientY);
    if (!el || el.nodeType !== 1) return;

    const target = el;

    const selector = buildSelector(target);
    const rect = target.getBoundingClientRect();
    const relX = rect.width ? ((e.clientX - rect.left) / rect.width) * 100 : 50;
    const relY = rect.height ? ((e.clientY - rect.top) / rect.height) * 100 : 50;

    const thread = {
      id: uuid(),
      createdAt: Date.now(),
      anchor: {
        selector,
        relX,
        relY,
        fallbackViewportX: e.clientX,
        fallbackViewportY: e.clientY,
      },
      resolved: false,
      resolvedAt: null,
      comments: [],
    };

    const threads = await getThreads();
    threads.push(thread);
    await setThreads(threads);

    state.reviewMode = false;
    overlayLayer.classList.remove('review-on');
    fab.classList.remove('active');
    fab.textContent = 'Review';

    state.selectedThreadId = thread.id;
    renderPins();
    openEditorForThread(thread, true);
  }

  function hidePanel() {
    stopRemotePoll();
    panelLayer.classList.add('dr-hidden');
    panelLayer.innerHTML = '';
  }

  async function refreshOpenPanelAfterProfileChange() {
    if (!panelLayer || panelLayer.classList.contains('dr-hidden')) return;
    const threads = await getThreads();
    if (state.selectedThreadId) {
      const t = threads.find((x) => x.id === state.selectedThreadId);
      if (t) openEditorForThread(t, false);
      else {
        state.selectedThreadId = null;
        openListPanel(threads);
      }
      return;
    }
    if (panelLayer.querySelector('#dr-profile-form')) {
      openProfilePanel();
      return;
    }
    openListPanel(threads);
  }

  function openProfilePanel() {
    panelLayer.classList.remove('dr-hidden');
    const name = cachedUserProfile.displayName;
    const email = cachedUserProfile.email;

    panelLayer.innerHTML = `
      <div class="dr-figma-header">
        <div>
          <h2 class="dr-figma-title">Profile</h2>
          <button type="button" class="dr-btn-text" id="dr-profile-back" style="margin-top:4px;display:block;text-align:left">
            ← Back to comments
          </button>
        </div>
        <div class="dr-figma-actions">
          <button type="button" class="dr-icon-btn" id="dr-close-panel" aria-label="Close">×</button>
        </div>
      </div>
      <div class="dr-figma-rule"></div>
      <div class="dr-figma-scroll" style="padding-top:12px">
        <p class="dr-profile-note" style="margin:0 16px 12px">
          Add your name and email so your comments are labelled clearly. A future version may use
          your email to notify you about new activity on pages you follow.
        </p>
        <form class="dr-profile-form" id="dr-profile-form" novalidate>
          <p class="dr-form-error dr-hidden" id="dr-profile-error" role="alert"></p>
          <div>
            <label for="dr-profile-name">Name</label>
            <input type="text" id="dr-profile-name" name="name" autocomplete="name" value="${escapeHtml(
              name,
            )}" required maxlength="80" />
          </div>
          <div>
            <label for="dr-profile-email">Email</label>
            <input type="email" id="dr-profile-email" name="email" autocomplete="email" value="${escapeHtml(
              email,
            )}" required maxlength="254" inputmode="email" />
          </div>
          <div class="dr-profile-actions">
            <button type="submit" class="dr-btn-primary">Save</button>
            <button type="button" class="dr-btn-secondary" id="dr-profile-clear">Clear profile</button>
          </div>
        </form>
      </div>
    `;

    const errEl = panelLayer.querySelector('#dr-profile-error');
    const form = panelLayer.querySelector('#dr-profile-form');
    const nameInput = panelLayer.querySelector('#dr-profile-name');
    const emailInput = panelLayer.querySelector('#dr-profile-email');

    panelLayer.querySelector('#dr-close-panel').addEventListener('click', hidePanel);
    panelLayer.querySelector('#dr-profile-back').addEventListener('click', () => {
      void getThreads().then((t) => openListPanel(t));
    });

    panelLayer.querySelector('#dr-profile-clear').addEventListener('click', async () => {
      await saveUserProfile({ displayName: '', email: '' });
      if (nameInput) nameInput.value = '';
      if (emailInput) emailInput.value = '';
      void refreshOpenPanelAfterProfileChange();
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      errEl.classList.add('dr-hidden');
      errEl.textContent = '';
      const n = (nameInput?.value || '').trim();
      const em = (emailInput?.value || '').trim();
      if (!n) {
        errEl.textContent = 'Please enter your name.';
        errEl.classList.remove('dr-hidden');
        nameInput?.focus();
        return;
      }
      if (!em) {
        errEl.textContent = 'Please enter your email.';
        errEl.classList.remove('dr-hidden');
        emailInput?.focus();
        return;
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) {
        errEl.textContent = 'Please enter a valid email address.';
        errEl.classList.remove('dr-hidden');
        emailInput?.focus();
        return;
      }
      try {
        await saveUserProfile({ displayName: n, email: em });
        void getThreads().then((t) => openListPanel(t));
      } catch (e2) {
        errEl.textContent = 'Could not save. Try again.';
        errEl.classList.remove('dr-hidden');
        console.warn('Design review: profile save failed', e2);
      }
    });

    nameInput?.focus();
    startRemotePoll();
  }

  function openListPanel(threads) {
    panelLayer.classList.remove('dr-hidden');
    const open = threads.filter((t) => !t.resolved).length;
    const resolved = threads.filter((t) => t.resolved).length;
    const hasProfile = Boolean(cachedUserProfile.displayName && cachedUserProfile.email);

    panelLayer.innerHTML = `
      <div class="dr-figma-header">
        <h2 class="dr-figma-title">Comments</h2>
        <div class="dr-figma-actions">
          <button type="button" class="dr-icon-btn" id="dr-open-profile" aria-label="Open profile" title="Profile">⚙</button>
          <button type="button" class="dr-icon-btn" id="dr-close-panel" aria-label="Close">×</button>
        </div>
      </div>
      <div class="dr-figma-rule"></div>
      ${
        hasProfile
          ? ''
          : `<div class="dr-banner-soft" role="status">
        Set your <strong>name and email</strong> in Profile so your team can see who commented.
        <button type="button" id="dr-banner-profile">Open Profile</button>
      </div>`
      }
      <p class="dr-muted dr-list-sub" style="margin:10px 0 0">${open} open · ${resolved} resolved</p>
      <p class="dr-muted dr-list-sub" style="margin:4px 0 8px">${escapeHtml(pageKey())}</p>
      <button type="button" class="dr-list-add" id="dr-start-mode">Add pin to page</button>
      <div id="dr-thread-list"></div>
    `;

    const profileBtn = panelLayer.querySelector('#dr-open-profile');
    profileBtn.addEventListener('click', () => openProfilePanel());
    const banner = panelLayer.querySelector('#dr-banner-profile');
    if (banner) banner.addEventListener('click', () => openProfilePanel());

    panelLayer.querySelector('#dr-close-panel').addEventListener('click', hidePanel);
    panelLayer.querySelector('#dr-start-mode').addEventListener('click', () => {
      state.reviewMode = true;
      overlayLayer.classList.add('review-on');
      fab.classList.add('active');
      fab.textContent = 'Review on';
      hidePanel();
    });

    const list = panelLayer.querySelector('#dr-thread-list');
    const sorted = [...threads].sort((a, b) => {
      if (a.resolved !== b.resolved) return a.resolved ? 1 : -1;
      const ta = a.comments[0]?.createdAt || a.createdAt || a.resolvedAt || 0;
      const tb = b.comments[0]?.createdAt || b.createdAt || b.resolvedAt || 0;
      return tb - ta;
    });

    sorted.forEach((t, i) => {
      const item = document.createElement('div');
      item.className = `dr-thread-item${t.resolved ? ' resolved' : ''}`;
      item.setAttribute('role', 'button');
      item.setAttribute('tabindex', '0');
      const preview =
        (t.comments.find((c) => c.body.trim()) || t.comments[0])?.body || 'No text yet';
      const label = t.resolved ? 'Resolved' : 'Open';
      item.innerHTML = `
        <div class="dr-thread-badge">Pin ${i + 1} · ${label}</div>
        <div class="dr-thread-item-preview">${escapeHtml(preview.slice(0, 140))}${preview.length > 140 ? '…' : ''}</div>
      `;
      const openThread = () => {
        state.selectedThreadId = t.id;
        renderPins();
        openEditorForThread(t, false);
      };
      item.addEventListener('click', openThread);
      item.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault();
          openThread();
        }
      });
      list.appendChild(item);
    });
    startRemotePoll();
  }

  function openEditorForThread(thread, isNew) {
    panelLayer.classList.remove('dr-hidden');
    renderThreadPanel(thread, isNew);
    startRemotePoll();
  }

  function renderThreadPanel(thread, isNew) {
    const roots = thread.comments.filter((c) => !c.parentId);
    const commentsHtml = roots.map((c) => renderCommentTree(thread, c)).join('');
    const noCommentsYet = thread.comments.length === 0;
    const ph = noCommentsYet ? 'Add a comment…' : 'Reply';

    panelLayer.innerHTML = `
      <div class="dr-figma-header">
        <div>
          <h2 class="dr-figma-title">Comment</h2>
          <button type="button" class="dr-btn-text" id="dr-back-list" style="margin-top:4px;display:block;text-align:left">
            ← All comments
          </button>
        </div>
        <div class="dr-figma-actions">
          <div class="dr-more-wrap">
            <button type="button" class="dr-icon-btn" id="dr-more-btn" aria-label="More options" aria-expanded="false">⋯</button>
            <div class="dr-more-menu dr-hidden" id="dr-more-menu" role="menu">
              <button type="button" role="menuitem" id="dr-copy-link">Copy link</button>
              <button type="button" role="menuitem" class="dr-danger" id="dr-delete-thread">Delete thread…</button>
            </div>
          </div>
          <button type="button" class="dr-icon-btn dr-resolve ${thread.resolved ? 'dr-resolve-on' : ''}" id="dr-resolve-btn" aria-label="Resolve thread" aria-pressed="${thread.resolved ? 'true' : 'false'}">✓</button>
          <button type="button" class="dr-icon-btn" id="dr-close-panel" aria-label="Close">×</button>
        </div>
      </div>
      <div class="dr-figma-rule"></div>
      <div class="dr-figma-scroll" id="dr-comments-scroll">
        ${commentsHtml || (noCommentsYet ? '<p class="dr-empty-hint">No comments yet.</p>' : '')}
      </div>
      <div class="dr-figma-foot">
        ${
          isNew && noCommentsYet
            ? `<p class="dr-empty-hint" style="margin:0 0 10px">${supabaseConfig() ? 'Comments sync to your team via Supabase.' : 'Stored on this device only.'}</p>`
            : ''
        }
        ${
          !cachedUserProfile.displayName || !cachedUserProfile.email
            ? `<p class="dr-empty-hint" style="margin:0 0 8px">Set your name and email in <strong>Profile</strong> (from the comment list) for clearer attribution.</p>`
            : ''
        }
        <p class="dr-muted" style="margin:0 0 8px;font-size:11px">Commenting as ${escapeHtml(
          reviewerDisplayName(),
        )}</p>
        <div class="dr-cmt-row" style="margin-bottom:0">
          <div class="dr-avatar sm" style="${avatarStyle(reviewerDisplayName())}">${avatarInitial(reviewerDisplayName())}</div>
          <div class="dr-cmt-main" style="flex:1;min-width:0">
            <div class="dr-pill-wrap">
              <textarea id="dr-new-body" rows="1" placeholder="${escapeHtml(ph)}"></textarea>
              <button type="button" class="dr-send" id="dr-post-send" aria-label="Send">↑</button>
            </div>
          </div>
        </div>
      </div>
    `;

    const moreBtn = panelLayer.querySelector('#dr-more-btn');
    const moreMenu = panelLayer.querySelector('#dr-more-menu');

    const closeMore = () => {
      moreMenu.classList.add('dr-hidden');
      moreBtn.setAttribute('aria-expanded', 'false');
    };

    function syncSendState(textarea) {
      const wrap = textarea.closest('.dr-pill-wrap');
      if (!wrap) return;
      const btn = wrap.querySelector('.dr-send');
      if (!btn) return;
      btn.classList.toggle('dr-send-active', (textarea.value || '').trim().length > 0);
    }

    panelLayer.querySelectorAll('.dr-pill-wrap textarea').forEach((ta) => {
      syncSendState(ta);
      ta.addEventListener('input', () => syncSendState(ta));
    });

    panelLayer.querySelector('#dr-close-panel').addEventListener('click', hidePanel);
    panelLayer.querySelector('#dr-back-list').addEventListener('click', async () => {
      state.selectedThreadId = null;
      renderPins();
      openListPanel(await getThreads());
    });

    moreBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (moreMenu.classList.contains('dr-hidden')) {
        moreMenu.classList.remove('dr-hidden');
        moreBtn.setAttribute('aria-expanded', 'true');
      } else {
        closeMore();
      }
    });

    panelLayer.querySelector('#dr-copy-link').addEventListener('click', async (e) => {
      e.stopPropagation();
      closeMore();
      const u = new URL(location.href);
      u.hash = `design-review-thread=${thread.id}`;
      try {
        await navigator.clipboard.writeText(u.toString());
      } catch {
        /* clipboard may be blocked */
      }
    });

    panelLayer.querySelector('#dr-delete-thread').addEventListener('click', async (e) => {
      e.stopPropagation();
      closeMore();
      if (!confirm('Delete this comment thread?')) return;
      const threads = (await getThreads()).filter((x) => x.id !== thread.id);
      await setThreads(threads);
      state.selectedThreadId = null;
      hidePanel();
      renderPins();
    });

    const resolveBtn = panelLayer.querySelector('#dr-resolve-btn');
    resolveBtn.addEventListener('click', async () => {
      const threads = await getThreads();
      const t = threads.find((x) => x.id === thread.id);
      if (!t) return;
      t.resolved = !t.resolved;
      t.resolvedAt = t.resolved ? Date.now() : null;
      await setThreads(threads);
      resolveBtn.classList.toggle('dr-resolve-on', t.resolved);
      resolveBtn.setAttribute('aria-pressed', String(t.resolved));
      renderPins();
    });

    panelLayer.querySelectorAll('[data-reply-to]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const parentId = btn.getAttribute('data-reply-to');
        const box = panelLayer.querySelector(`#dr-reply-${parentId}`);
        if (box) {
          box.classList.toggle('dr-hidden');
          const textarea = box.querySelector('textarea');
          if (textarea) syncSendState(textarea);
        }
      });
    });

    panelLayer.querySelectorAll('[data-submit-reply]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!btn.classList.contains('dr-send-active')) return;
        const parentId = btn.getAttribute('data-submit-reply');
        const input = panelLayer.querySelector(`#dr-reply-body-${parentId}`);
        const body = (input?.value || '').trim();
        if (!body) return;
        const threads = await getThreads();
        const t = threads.find((x) => x.id === thread.id);
        if (!t) return;
        t.comments.push({
          id: uuid(),
          parentId,
          body,
          author: reviewerDisplayName(),
          createdAt: Date.now(),
        });
        await setThreads(threads);
        const fresh = threads.find((x) => x.id === thread.id);
        openEditorForThread(fresh, false);
      });
    });

    const postMain = async () => {
      const ta = panelLayer.querySelector('#dr-new-body');
      const body = (ta?.value || '').trim();
      if (!body) return;
      const threads = await getThreads();
      const t = threads.find((x) => x.id === thread.id);
      if (!t) return;
      const root = t.comments.find((c) => !c.parentId);
      if (!root) {
        t.comments.push({
          id: uuid(),
          parentId: null,
          body,
          author: reviewerDisplayName(),
          createdAt: Date.now(),
        });
      } else {
        t.comments.push({
          id: uuid(),
          parentId: root.id,
          body,
          author: reviewerDisplayName(),
          createdAt: Date.now(),
        });
      }
      await setThreads(threads);
      const fresh = threads.find((x) => x.id === thread.id);
      openEditorForThread(fresh, false);
    };

    const sendBtn = panelLayer.querySelector('#dr-post-send');
    sendBtn.addEventListener('click', postMain);
    panelLayer.querySelector('#dr-new-body').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        postMain();
      }
    });
  }

  /** Depth-first order: children sorted by time at each level. */
  function flattenReplyList(thread, parentId, out = []) {
    const kids = thread.comments
      .filter((c) => c.parentId === parentId)
      .sort((a, b) => a.createdAt - b.createdAt);
    for (const k of kids) {
      out.push(k);
      flattenReplyList(thread, k.id, out);
    }
    return out;
  }

  function renderReplyRow(thread, comment) {
    const replyBoxId = `dr-reply-${comment.id}`;
    const bodyHtml = comment.body.trim()
      ? formatCommentBody(comment.body)
      : '<em class="dr-empty-hint">(empty)</em>';
    return `
      <div class="dr-cmt-row dr-cmt-reply-flat">
        <div class="dr-avatar sm" style="${avatarStyle(comment.author)}">${avatarInitial(comment.author)}</div>
        <div class="dr-cmt-main">
          <div class="dr-cmt-head">
            <span class="dr-cmt-name">${escapeHtml(comment.author)}</span>
            <span class="dr-cmt-time">${formatRelativeTime(comment.createdAt)}</span>
          </div>
          <div class="dr-cmt-body">${bodyHtml}</div>
          <button type="button" class="dr-btn-text" data-reply-to="${comment.id}">Reply</button>
          <div id="${replyBoxId}" class="dr-hidden dr-reply-inline">
            <div class="dr-pill-wrap">
              <textarea id="dr-reply-body-${comment.id}" rows="1" placeholder="Reply"></textarea>
              <button type="button" class="dr-send" data-submit-reply="${comment.id}" aria-label="Send reply">↑</button>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  function renderCommentTree(thread, comment) {
    const replyBoxId = `dr-reply-${comment.id}`;
    const bodyHtml = comment.body.trim()
      ? formatCommentBody(comment.body)
      : '<em class="dr-empty-hint">(empty)</em>';
    const flatReplies = flattenReplyList(thread, comment.id);
    const repliesHtml = flatReplies.map((c) => renderReplyRow(thread, c)).join('');
    return `
      <div class="dr-cmt-thread-group">
        <div class="dr-cmt-row dr-cmt-root">
          <div class="dr-avatar sm" style="${avatarStyle(comment.author)}">${avatarInitial(comment.author)}</div>
          <div class="dr-cmt-main">
            <div class="dr-cmt-head">
              <span class="dr-cmt-name">${escapeHtml(comment.author)}</span>
              <span class="dr-cmt-time">${formatRelativeTime(comment.createdAt)}</span>
            </div>
            <div class="dr-cmt-body">${bodyHtml}</div>
            <button type="button" class="dr-btn-text" data-reply-to="${comment.id}">Reply</button>
            <div id="${replyBoxId}" class="dr-hidden dr-reply-inline">
              <div class="dr-pill-wrap">
                <textarea id="dr-reply-body-${comment.id}" rows="1" placeholder="Reply"></textarea>
                <button type="button" class="dr-send" data-submit-reply="${comment.id}" aria-label="Send reply">↑</button>
              </div>
            </div>
          </div>
        </div>
        <div class="dr-cmt-replies-flat" aria-label="Replies">
          ${repliesHtml}
        </div>
      </div>
    `;
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  async function renderPins() {
    injectShell();
    overlayLayer.querySelectorAll('.dr-pin').forEach((p) => p.remove());

    const threads = await getThreads();
    threads.forEach((t, i) => {
      const pos = pinPositionForThread(t);
      const pin = document.createElement('button');
      pin.type = 'button';
      pin.className = `dr-pin${t.resolved ? ' resolved' : ''}${state.selectedThreadId === t.id ? ' selected' : ''}`;
      pin.textContent = threadPinLabel(t);
      pin.style.left = `${pos.x}px`;
      pin.style.top = `${pos.y}px`;
      pin.title = t.resolved ? 'Resolved thread' : 'Open thread';
      pin.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        state.selectedThreadId = t.id;
        renderPins();
        openEditorForThread(t, false);
      });
      overlayLayer.appendChild(pin);
    });
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'TOGGLE_REVIEW_MODE') {
      injectShell();
      if (state.reviewMode) {
        toggleReviewMode();
        return;
      }
      if (!panelLayer.classList.contains('dr-hidden')) {
        hidePanel();
        return;
      }
      void loadUserProfileFromStorage().then(() => {
        getThreads().then((threads) => openListPanel(threads));
      });
    }
  });

  injectShell();
  void Promise.all([getThreads(), loadUserProfileFromStorage()]).then(() => renderPins());

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes[STORAGE_KEY]) {
      renderPins();
    }
    if (changes[USER_PROFILE_KEY]) {
      void loadUserProfileFromStorage().then(async () => {
        await refreshOpenPanelAfterProfileChange();
        renderPins();
      });
    }
  });
})();
