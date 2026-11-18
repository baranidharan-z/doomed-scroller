// Runs in YouTube / Reddit / LinkedIn tabs. Measures active time locally,
// flushes it to the background every few seconds, shows a full-width timer bar
// at the top of the page, and renders the warn/block overlay from the reply.
'use strict';

(function () {
  const site = DS.siteForHost(location.hostname);
  if (!site) return;

  const TICK_MS = 1000;
  const FLUSH_MS = 5000;
  const MAX_TICK_MS = 2000; // clamp so a sleeping laptop doesn't add hours

  const BAR_H = 36; // px; normal bar height
  let barH = BAR_H; // current bar height; grows near the limit

  // Measured here, not yet sent to the background.
  let pendingMs = 0;
  // Sent, reply not yet received. Shown in the timer so it doesn't dip.
  let inFlightMs = 0;
  let counting = false; // was time being counted on the last tick?
  let lastInput = Date.now();
  let lastTick = Date.now();
  let current = null; // last reply from background
  let timers = [];

  // ---- measurement -------------------------------------------------------

  function onInput() {
    lastInput = Date.now();
  }

  // Any of these means the user is present. Capture phase so feeds that
  // scroll an inner container (scroll events don't bubble) still count.
  for (const ev of ['scroll', 'wheel', 'keydown', 'mousemove', 'touchstart', 'click']) {
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
    counting = active;
    safeUpdateTimer();
    try {
      shiftPinned();
    } catch (e) {
      console.error('[doomed] moving pinned elements failed', { site }, e);
    }
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
    pendingMs = 0;
    inFlightMs = activeMs;
    let res;
    try {
      res = await send({ type: 'tick', site, activeMs });
    } catch (e) {
      // Not acknowledged: put the time back so the next flush retries it.
      pendingMs += activeMs;
      console.warn('[doomed] flush failed, will retry', e);
      return;
    } finally {
      inFlightMs = 0;
    }
    // Acknowledged: time is persisted. A render failure past this point
    // must NOT re-queue it (that double-counted usage before).
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

  // ---- shared DOM helpers ------------------------------------------------

  // Built with DOM APIs only. YouTube enforces Trusted Types, which rejects
  // string assignment to innerHTML even from extension content scripts.
  function el(tag, className, ...children) {
    const e = document.createElement(tag);
    if (className) e.className = className;
    e.append(...children);
    return e;
  }

  // While something is fullscreen, only that element's subtree is drawn, so
  // our UI has to live inside it. A <video>/<iframe> can't host children.
  function mountParent() {
    const fs = document.fullscreenElement;
    const tag = fs && String(fs.tagName).toUpperCase();
    return fs && tag !== 'VIDEO' && tag !== 'IFRAME' ? fs : document.documentElement;
  }

  function mount(h) {
    const parent = mountParent();
    if (h.parentNode !== parent) parent.appendChild(h);
  }

  // ---- warn / block overlay ----------------------------------------------

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
    h.attachShadow({ mode: 'closed' }).append(style, el('div', 'bg', card));

    ext.addEventListener('click', extend);
    close.addEventListener('click', closeTab);
    // Assign only once fully built, so a failure never leaves a half-made host.
    ui = { title, msg, stats, extend: ext, close };
    host = h;
  }

  function pauseMedia() {
    document.querySelectorAll('video, audio').forEach((m) => m.pause());
  }

  // ---- timer bar -------------------------------------------------------
  // Full-width bar at the very top: name | time wasted today | total time.
  // Shows saved total + in-flight + pending, refreshed every tick. Ignores the
  // mouse so it never blocks the site underneath.

  // Stage colours (see the grown-bar section below):
  //   calm    deep teal  - blue-green lowers arousal; invites reflection, not defensiveness
  //   caution amber      - reads as "slow down" without alarm
  //   stop    deep crimson - red cues stopping/avoidance; kept muted, since a
  //                          stress spike tends to feed impulsive scrolling
  const TIMER_CSS = `
    .wrap { height: 100%; display: flex; flex-direction: column; }
    .bar { box-sizing: border-box; height: ${BAR_H}px; flex: none; display: flex; align-items: center;
           justify-content: space-between; gap: 16px; padding: 0 16px; white-space: nowrap;
           font: 700 16px/1 system-ui, sans-serif; background: #0e0e12; color: #ececf1;
           border-bottom: 1px solid #2a2a33; }
    .side { flex: 1 1 0; display: flex; align-items: center; min-width: 0; }
    .side.right { justify-content: flex-end; }
    .name { letter-spacing: .3px; }
    .wasted { display: flex; align-items: baseline; gap: 8px; color: #ececf1; }
    .wasted .val { color: #ff8a80; }
    .total { color: #34c759; }
    .val { font-size: 18px; font-variant-numeric: tabular-nums; }
    .status { font-size: 13px; font-weight: 600; opacity: .75; }

    .grow { flex: 1; min-height: 0; box-sizing: border-box; display: flex; flex-direction: column;
            align-items: center; justify-content: center; gap: 10px; padding: 8px 24px 0;
            font-family: system-ui, sans-serif; text-align: center; position: relative;
            transition: background .6s ease, color .6s ease; }
    .grow.calm    { background: linear-gradient(180deg, #0b3a3b, #0f4c4a); color: #e6fffb; --accent: #5eead4; }
    .grow.caution { background: linear-gradient(180deg, #3a2608, #4d3310); color: #fff7e6; --accent: #fbbf24; }
    .grow.stop    { background: linear-gradient(180deg, #3a0c14, #4f101b); color: #ffe4e6; --accent: #fb7185; }
    /* Short bar: quote and author side by side on one row. */
    .grow.tight { flex-direction: row; flex-wrap: wrap; gap: 4px 16px; padding-top: 0; }
    .quote { font: italic 600 20px/1.35 Georgia, 'Times New Roman', serif; max-width: 1100px;
             white-space: normal; text-wrap: balance; }
    .author { font-size: 15px; font-weight: 700; color: var(--accent); letter-spacing: .3px;
              white-space: nowrap; }
    .progress { position: absolute; left: 0; right: 0; bottom: 0; height: 6px;
                background: rgba(255,255,255,.12); }
    .fill { height: 100%; width: 0; background: var(--accent); transition: width .9s linear; }
    [hidden] { display: none !important; }`;

  let timerHost = null;
  let timerUi = null;
  let timerPlacement = '';

  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  function fmtClock(ms) {
    const s = Math.floor(Math.max(0, ms) / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return h ? `${h}:${pad2(m)}:${pad2(s % 60)}` : `${m}:${pad2(s % 60)}`;
  }

  function buildTimer() {
    const style = document.createElement('style');
    style.textContent = TIMER_CSS;
    const used = el('span', 'val');
    const total = el('span', 'val');
    const status = el('span', 'status', 'paused');
    const bar = el('div', 'bar',
      el('div', 'side', el('span', 'name', 'DoomedScroller')),
      el('div', 'wasted', 'Time wasted today', used, status),
      el('div', 'side right', el('span', 'total', `Total time for ${site}: `, total)));

    // Fills the extra height once the bar grows near the limit: a philosophy
    // quote to read instead of the feed.
    const quote = el('div', 'quote');
    const author = el('div', 'author');
    const fill = el('div', 'fill');
    const grow = el('div', 'grow', quote, author, el('div', 'progress', fill));
    grow.hidden = true;

    const h = document.createElement('div');
    h.attachShadow({ mode: 'closed' }).append(style, el('div', 'wrap', bar, grow));
    timerUi = { used, total, status, grow, quote, author, fill };
    timerHost = h;
    timerPlacement = '';
  }

  function updateTimer() {
    if (!current) return;
    if (!timerHost) buildTimer();
    mount(timerHost);

    const ms = current.rec.activeMs + inFlightMs + pendingMs;

    // Near the limit the bar grows and squeezes the page (DS.barGrowPercent).
    const pct = DS.barGrowPercent(ms / current.thresholds.ms, current.rec.extensions);
    const h = Math.max(BAR_H, Math.round((window.innerHeight * pct) / 100));
    const heightChanged = h !== barH;
    barH = h;

    // Same box either way; inside a fullscreen element it overlays the video.
    const where = `${document.fullscreenElement ? 'fs' : 'page'}:${barH}`;
    if (where !== timerPlacement) {
      timerHost.style.cssText =
        `all: initial; position: fixed; top: 0; left: 0; right: 0; height: ${barH}px; ` +
        'z-index: 2147483646; pointer-events: none;';
      timerPlacement = where;
    }
    // Push the page down so it starts below the bar. The margin moves normal
    // content; making <html> positioned also moves absolutely positioned app
    // shells (YouTube's ytd-app is `position:absolute; top:0` with no
    // positioned ancestor, so without this it ignores the margin entirely).
    // Fixed/sticky elements are handled separately by shiftPinned().
    const rootStyle = document.documentElement.style;
    rootStyle.setProperty('position', 'relative', 'important');
    rootStyle.setProperty('margin-top', `${barH}px`, 'important');
    if (heightChanged) reshiftAll();

    timerUi.used.textContent = fmtClock(ms);
    timerUi.total.textContent = fmtClock(current.thresholds.ms);
    timerUi.status.hidden = counting;
    updateQuote(pct, ms);
  }

  // ---- grown bar: philosophy to read instead of the feed ------------------
  // The background picks from its fetched pool; the same quote shows in every
  // tab for one rotation window. The previous quote stays up until the next
  // one arrives (no flicker); built-in quotes cover the first moments and the
  // case where the background has none.

  let shownQuote = null; // { text, author } on screen
  let quoteSlot = -1;    // rotation window we're in
  let quoteAsked = -1;   // window already requested from the background

  function requestQuote(slot) {
    quoteAsked = slot;
    send({ type: 'getQuote' })
      .then((res) => {
        if (slot !== quoteSlot) return; // a newer window took over
        const q = res && res.quote ? DS.cleanQuote(res.quote) : null;
        shownQuote = q || DS.pickQuote(DS.FALLBACK_QUOTES, Date.now());
        safeUpdateTimer();
      })
      .catch((e) => console.warn('[doomed] getQuote failed', e));
  }

  function updateQuote(pct, ms) {
    const ui = timerUi;
    const stage = DS.stageFor(pct, current.rec.extensions);
    if (!stage) {
      ui.grow.hidden = true;
      ui.quote.textContent = '';
      ui.author.textContent = '';
      return;
    }

    const now = Date.now();
    quoteSlot = Math.floor(now / DS.CONFIG.quoteRotateMs);
    if (!shownQuote) shownQuote = DS.pickQuote(DS.FALLBACK_QUOTES, now);
    if (quoteAsked !== quoteSlot) requestQuote(quoteSlot);

    ui.grow.hidden = false;
    const room = barH - BAR_H; // px available below the stats row
    const tight = room < 90;
    ui.grow.className = `grow ${stage}${tight ? ' tight' : ''}`;

    const text = `\u201C${shownQuote.text}\u201D`;
    const by = `\u2014 ${shownQuote.author}`;
    if (ui.quote.textContent !== text) ui.quote.textContent = text;
    if (ui.author.textContent !== by) ui.author.textContent = by;

    // Bigger with more room, smaller for long quotes so they still fit.
    const len = shownQuote.text.length;
    const shrink = len > 230 ? 0.7 : len > 160 ? 0.8 : 1;
    const size = tight ? 18 : Math.max(16, Math.min(34, Math.round(room * 0.2 * shrink)));
    ui.quote.style.fontSize = `${size}px`;
    ui.fill.style.width = `${Math.min(100, (ms / current.thresholds.ms) * 100).toFixed(1)}%`;
  }

  function safeUpdateTimer() {
    try {
      updateTimer();
    } catch (e) {
      console.error('[doomed] timer update failed', { site }, e);
    }
  }

  // Elements pinned to the window (position fixed/sticky, like YouTube's top
  // bar and side menu) ignore the margin above, so they'd sit under our bar.
  // Each tick, look at what's pinned in the top strip and move it down by the
  // bar height. `moved` remembers each element's original offset and the value
  // we set: an element is moved once, again if the site resets its style, and
  // re-moved from its original offset whenever the bar changes height.
  const moved = new Map(); // node -> { orig, value }; detached nodes pruned

  function applyShift(node, orig) {
    const value = `${Math.round(orig + barH)}px`;
    node.style.setProperty('top', value, 'important');
    moved.set(node, { orig, value });
  }

  function reshiftAll() {
    for (const [node, m] of moved) {
      if (!node.isConnected) moved.delete(node);
      else applyShift(node, m.orig);
    }
  }
  const PROBE_Y = [1, 40, 80, 120];
  const PROBE_X = [0.02, 0.2, 0.5, 0.8, 0.98];
  const MAX_PINNED_TOP = 200; // px; lower than this isn't a top-anchored header

  function shiftPinned() {
    if (!timerHost || document.fullscreenElement || !document.elementsFromPoint) return;
    const seen = new Set();
    for (const y of PROBE_Y) {
      for (const fx of PROBE_X) {
        for (const node of document.elementsFromPoint(Math.round(window.innerWidth * fx), y)) {
          if (seen.has(node)) continue;
          seen.add(node);
          if (node === timerHost || node === host ||
              node === document.documentElement || node === document.body) continue;
          const m = moved.get(node);
          if (m && node.style.getPropertyValue('top') === m.value) continue;
          const cs = getComputedStyle(node);
          if (cs.position !== 'fixed' && cs.position !== 'sticky') continue;
          const top = parseFloat(cs.top);
          if (!Number.isFinite(top) || top > MAX_PINNED_TOP) continue;
          applyShift(node, top);
        }
      }
    }
  }

  // ---- render ------------------------------------------------------------

  function render(res) {
    current = res;
    updateTimer();
    if (res.state === 'ok') {
      if (overlayVisible()) host.remove();
      renderedKey = '';
      return;
    }

    pauseMedia();
    if (!host) buildOverlay();
    mount(host);

    const { rec, maxExtensions } = res;
    const key = `${res.state}:${rec.extensions}`;
    if (key === renderedKey) return; // don't re-render (keeps focus) every 5s
    renderedKey = key;

    const mins = Math.round(rec.activeMs / 60000);
    ui.stats.textContent =
      `Time wasted today on ${site}: ${mins} min. ` +
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

  // Entering/leaving fullscreen: move our UI into (or out of) the
  // fullscreen element right away rather than on the next tick.
  document.addEventListener('fullscreenchange', () => {
    if (overlayVisible()) mount(host);
    safeUpdateTimer();
  });

  // ---- start -------------------------------------------------------------

  timers.push(setInterval(tick, TICK_MS));
  timers.push(setInterval(flush, FLUSH_MS));
  flush(); // immediate: a blocked site should block on page load, not 5s later
})();
