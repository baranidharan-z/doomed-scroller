// Runs in YouTube / Reddit / LinkedIn tabs. Measures active time and scroll
// depth locally, flushes deltas to the background every few seconds, and
// renders the warn/block overlay based on the reply.
'use strict';

(function () {
  const site = DS.siteForHost(location.hostname);
  if (!site) return;

  const TICK_MS = 1000;
  const FLUSH_MS = 5000;
  const MAX_TICK_MS = 2000; // clamp so a sleeping laptop doesn't add hours
  const MAX_SCREENS_PER_EVENT = 3; // clamp "jump to top" style scrolls

  let pendingMs = 0;
  let pendingScreens = 0;
  let lastInput = Date.now();
  let lastTick = Date.now();
  let current = null; // last reply from background
  let timers = [];

  // ---- measurement -------------------------------------------------------

  const lastPos = new WeakMap();

  function onScroll(e) {
    const t = e.target;
    const el = t === document || t === document.documentElement || t === document.body
      ? document.scrollingElement
      : t;
    if (!(el instanceof Element)) return;
    const top = el.scrollTop;
    const prev = lastPos.get(el);
    lastPos.set(el, top);
    lastInput = Date.now();
    if (prev === undefined) return;
    const screens = Math.abs(top - prev) / Math.max(window.innerHeight, 1);
    pendingScreens += Math.min(screens, MAX_SCREENS_PER_EVENT);
  }

  function onInput() {
    lastInput = Date.now();
  }

  // Capture phase: feeds that scroll an inner container (not window) still
  // reach us. Scroll events don't bubble, so capture is required.
  document.addEventListener('scroll', onScroll, { capture: true, passive: true });
  for (const ev of ['wheel', 'keydown', 'mousemove', 'touchstart', 'click']) {
    document.addEventListener(ev, onInput, { capture: true, passive: true });
  }

  function tick() {
    const now = Date.now();
    const dt = Math.min(now - lastTick, MAX_TICK_MS);
    lastTick = now;
    const active =
      document.visibilityState === 'visible' &&
      document.hasFocus() &&
      now - lastInput < DS.CONFIG.idleMs &&
      !overlayVisible();
    if (active) pendingMs += dt;
  }

  // ---- messaging ---------------------------------------------------------

  function stop(reason) {
    timers.forEach(clearInterval);
    timers = [];
    console.info('[doomed] stopped:', reason);
  }

  async function send(msg) {
    // After the extension is reloaded, this orphaned script loses its
    // runtime. Stop cleanly instead of throwing every 5s.
    if (!chrome.runtime?.id) {
      stop('extension context invalidated (reload the page)');
      return null;
    }
    const res = await chrome.runtime.sendMessage(msg);
    if (res?.error) throw new Error(res.error);
    return res;
  }

  async function flush() {
    const activeMs = pendingMs;
    const screens = pendingScreens;
    pendingMs = 0;
    pendingScreens = 0;
    let res;
    try {
      res = await send({ type: 'tick', site, activeMs, screens });
    } catch (e) {
      // Not acknowledged: put the deltas back so the next flush retries them.
      pendingMs += activeMs;
      pendingScreens += screens;
      console.warn('[doomed] flush failed, will retry', e);
      return;
    }
    // Acknowledged: deltas are persisted. A render failure past this point
    // must NOT re-queue them (that double-counted usage before).
    if (res) safeRender(res);
  }

  async function extend() {
    if (!current) return;
    let res;
    try {
      res = await send({ type: 'extend', site, seenExtensions: current.rec.extensions });
    } catch (e) {
      console.warn('[doomed] extend failed', e);
      return;
    }
    if (res) safeRender(res);
  }

  function closeTab() {
    send({ type: 'closeTab' }).catch((e) => console.warn('[doomed] closeTab failed', e));
  }

  // ---- overlay -----------------------------------------------------------

  let host = null;
  let ui = null;
  let renderedKey = '';

  function overlayVisible() {
    return !!host && host.isConnected;
  }

  const OVERLAY_CSS = `
    .bg { position: fixed; inset: 0; background: rgba(10,10,14,.82);
          backdrop-filter: blur(8px); display: flex; align-items: center;
          justify-content: center; font: 16px/1.5 system-ui, sans-serif; }
    .card { background: #fff; color: #16161d; max-width: 420px; width: calc(100% - 32px);
            border-radius: 14px; padding: 28px; box-shadow: 0 20px 60px rgba(0,0,0,.4); }
    h1 { margin: 0 0 8px; font-size: 22px; }
    p { margin: 0 0 6px; color: #444; }
    .stats { margin: 14px 0 20px; padding: 12px; background: #f3f3f6; border-radius: 8px; }
    .row { display: flex; gap: 10px; }
    button { flex: 1; padding: 10px 14px; border-radius: 8px; border: 0;
             font: inherit; font-weight: 600; cursor: pointer; }
    .primary { background: #16161d; color: #fff; }
    .secondary { background: #e6e6ec; color: #16161d; }
    [hidden] { display: none !important; }`;

  function el(tag, className, ...children) {
    const e = document.createElement(tag);
    if (className) e.className = className;
    e.append(...children);
    return e;
  }

  // Built with DOM APIs only. YouTube enforces Trusted Types, which rejects
  // string assignment to innerHTML even from extension content scripts.
  function buildOverlay() {
    const style = document.createElement('style');
    style.textContent = OVERLAY_CSS;
    const title = el('h1');
    const msg = el('p');
    const stats = el('div', 'stats');
    const close = el('button', 'primary', 'Close tab');
    const ext = el('button', 'secondary', '5 more minutes');
    const card = el('div', 'card', title, msg, stats, el('div', 'row', close, ext));
    card.setAttribute('role', 'alertdialog');
    card.setAttribute('aria-modal', 'true');

    const h = document.createElement('div');
    h.style.cssText = 'all: initial; position: fixed; inset: 0; z-index: 2147483647;';
    const root = h.attachShadow({ mode: 'closed' });
    root.append(style, el('div', 'bg', card));

    ext.addEventListener('click', extend);
    close.addEventListener('click', closeTab);
    // Assign only once fully built, so a failure never leaves a half-made host.
    ui = { title, msg, stats, extend: ext, close };
    host = h;
  }

  function safeRender(res) {
    try {
      render(res);
    } catch (e) {
      // Deliberately contained: usage is already persisted, and an exception
      // here must not leave an invisible full-screen host blocking the page.
      console.error('[doomed] render failed', { site, state: res.state }, e);
      if (host) host.remove();
      host = null;
      ui = null;
      renderedKey = '';
    }
  }

  function pauseMedia() {
    document.querySelectorAll('video, audio').forEach((m) => m.pause());
  }

  function render(res) {
    current = res;
    if (res.state === 'ok') {
      if (overlayVisible()) host.remove();
      renderedKey = '';
      return;
    }

    pauseMedia();
    if (!host) buildOverlay();
    if (!host.isConnected) document.documentElement.appendChild(host);

    const { rec, maxExtensions } = res;
    const key = `${res.state}:${rec.extensions}`;
    if (key === renderedKey) return; // don't re-render (keeps focus) every 5s
    renderedKey = key;

    const mins = Math.round(rec.activeMs / 60000);
    const screens = Math.round(rec.screens);
    ui.stats.textContent =
      `Today on ${site}: ${mins} min active, ${screens} screens scrolled. ` +
      `Extensions used: ${rec.extensions}/${maxExtensions}.`;

    if (res.state === 'warn') {
      const left = maxExtensions - rec.extensions;
      ui.title.textContent = 'You’re doomscrolling';
      ui.msg.textContent = left === 1
        ? 'Last extension. Next time this site is blocked until midnight.'
        : `${left} extensions left before ${site} is blocked for the day.`;
      ui.extend.hidden = false;
    } else {
      ui.title.textContent = `${site} is blocked for today`;
      ui.msg.textContent = 'You used all your extensions. It unlocks at midnight.';
      ui.extend.hidden = true;
    }
    ui.close.focus();
  }

  // ---- start -------------------------------------------------------------

  timers.push(setInterval(tick, TICK_MS));
  timers.push(setInterval(flush, FLUSH_MS));
  flush(); // immediate: a blocked site should block on page load, not 5s later
})();
