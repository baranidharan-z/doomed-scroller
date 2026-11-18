// Runs in tabs of tracked sites: the built-in ones (via the manifest) and
// sites added in settings (via a dynamically registered script). Measures
// active time locally, flushes it to the background every few seconds, shows
// a full-width timer bar at the top of the page, and renders the warn/block
// overlay from the reply.
'use strict';

(function () {
  const builtIn = DS.siteForHost(location.hostname);
  if (builtIn) {
    start(builtIn);
  } else {
    // Possibly a site added in settings; the list lives in storage.
    chrome.storage.local.get('customSites')
      .then((got) => {
        const added = DS.siteForHost(location.hostname, DS.customSites(got.customSites));
        if (added) start(added);
      })
      .catch((e) => console.error('[doomed] reading added sites failed', e));
  }

  function start(site) {
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
      if (overlayVisible()) updateExtendButton();
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
      if (!current || !ui || ui.extend.disabled) return; // locked during the cool-off
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
      button:disabled { opacity: .6; cursor: not-allowed; font-variant-numeric: tabular-nums; }
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

    // "More minutes" stays locked until the background's extendAt (the warning
    // start plus the cool-off). The background enforces it too; this is the UI.
    function updateExtendButton() {
      if (!ui || !current || current.state !== 'warn') return;
      const wait = (current.extendAt || 0) - Date.now();
      const text = wait > 0
        ? `Come back in ${fmtClock(Math.ceil(wait / 1000) * 1000)} to extend`
        : `${current.extendMinutes || DS.CONFIG.extendMinutes} more minutes`;
      ui.extend.disabled = wait > 0;
      if (ui.extend.textContent !== text) ui.extend.textContent = text;
    }

    // ---- timer bar -------------------------------------------------------
    // One full-width bar at the very top: name | time wasted today | total.
    // From 75% of the allowance it grows smoothly to 35% of the window height,
    // pushing the page down; its colour and the time-wasted digits grow with it.
    // Shows saved total + in-flight + pending, refreshed every tick. Ignores the
    // mouse so it never blocks the site underneath.
    //
    // Stage colours: soft, low-glare palettes (muted backgrounds, gently tinted
    // light text), easy on the eyes in a dark room.
    //   calm    soft teal  - blue-green lowers arousal
    //   caution warm sand  - reads as "slow down" without alarm
    //   stop    muted rose - signals stop without a harsh, stressful red

    const TIMER_CSS = `
      .bar { box-sizing: border-box; height: 100%; position: relative; display: flex;
             align-items: center; justify-content: space-between; gap: 16px; padding: 0 18px;
             white-space: nowrap; font: 700 16px/1 system-ui, sans-serif;
             background: #0e0e12; color: #ececf1; border-bottom: 1px solid #2a2a33;
             --accent: #ff8a80; --total: #34c759;
             transition: background .8s ease, color .8s ease; }
      .bar.calm    { background: linear-gradient(180deg, #10302f, #173f3c); color: #d9f5ef;
                     --accent: #8fe3cf; --total: #b7efc0; border-color: transparent; }
      .bar.caution { background: linear-gradient(180deg, #33281a, #3e3121); color: #f7ead6;
                     --accent: #f2c98a; --total: #cfe8b0; border-color: transparent; }
      .bar.stop    { background: linear-gradient(180deg, #33191f, #3e2027); color: #f8dfe3;
                     --accent: #f2a0ad; --total: #d6e6c0; border-color: transparent; }
      .side { flex: 1 1 0; display: flex; align-items: center; min-width: 0; }
      .side.right { justify-content: flex-end; }
      .name { letter-spacing: .3px; opacity: .9; }
      .wasted { display: flex; align-items: baseline; gap: 10px; }
      .bar.tall .wasted { flex-direction: column; align-items: center; gap: 8px; }
      .label { font-size: 15px; }
      .bar.tall .label { font-size: 14px; font-weight: 600; letter-spacing: 3px;
                         text-transform: uppercase; opacity: .8; }
      .used { font-size: 18px; line-height: 1; color: var(--accent); font-variant-numeric: tabular-nums; }
      .bar.tall .used { font-weight: 300; letter-spacing: 2px; }
      .total { color: var(--total); font-variant-numeric: tabular-nums; }
      .status { font-size: 13px; font-weight: 600; opacity: .75; }
      .progress { position: absolute; left: 0; right: 0; bottom: 0; height: 6px;
                  background: rgba(255,255,255,.12); }
      .fill { height: 100%; width: 0; background: var(--accent); transition: width .9s linear; }
      [hidden] { display: none !important; }`;

    const TALL_BAR = 90; // px; from here the time is stacked under its label
    const BAR_STEP = 4; // px; height is rounded to this so the page isn't re-laid out every second

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
      const used = el('span', 'used');
      const total = el('span', 'tval');
      const status = el('span', 'status', 'paused');
      const fill = el('div', 'fill');
      const progress = el('div', 'progress', fill);
      progress.hidden = true;
      const bar = el('div', 'bar',
        el('div', 'side', el('span', 'name', 'DoomedScroller')),
        el('div', 'wasted', el('span', 'label', 'Time wasted today'), used, status),
        el('div', 'side right', el('span', 'total', `Total time for ${site}: `, total)),
        progress);

      const h = document.createElement('div');
      h.attachShadow({ mode: 'closed' }).append(style, bar);
      timerUi = { bar, used, total, status, progress, fill };
      timerHost = h;
      timerPlacement = '';
    }

    function updateTimer() {
      if (!current) return;
      if (!timerHost) buildTimer();
      mount(timerHost);

      const ms = current.rec.activeMs + inFlightMs + pendingMs;
      const fraction = ms / current.thresholds.ms;
      const extensions = current.rec.extensions;

      // Near the limit the bar grows and squeezes the page (DS.barGrowPercent).
      const pct = DS.barGrowPercent(fraction, extensions);
      const grown = Math.round((window.innerHeight * pct) / 100 / BAR_STEP) * BAR_STEP;
      const h = Math.max(BAR_H, grown);
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
      fitFullscreen();

      const ui = timerUi;
      const stage = DS.stageFor(fraction, extensions);
      const tall = barH >= TALL_BAR;
      ui.bar.className = `bar${stage ? ` ${stage}` : ''}${tall ? ' tall' : ''}`;
      ui.used.textContent = fmtClock(ms);
      // The time grows with the bar: 18px normally, up to 160px.
      const size = tall ? Math.max(28, Math.min(160, Math.round((barH - 40) * 0.6))) : 18;
      ui.used.style.fontSize = `${size}px`;
      ui.total.textContent = fmtClock(current.thresholds.ms);
      ui.status.hidden = counting;
      ui.progress.hidden = !stage;
      if (stage) ui.fill.style.width = `${Math.min(100, fraction * 100).toFixed(1)}%`;
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

    // Fullscreen of the whole page. youtube.com fullscreens <html> itself (its
    // player calls requestFullscreen on document.documentElement). The browser's
    // fullscreen styles don't reset <html>'s margin, so the page stays pushed
    // down by the bar while the player area is exactly 100vh tall: the bottom
    // of the video is cut off. Shrink the player area to fit below the bar and
    // fire a resize so the player re-fits the video (letterboxed, not cropped).
    // Other sites fullscreen a single element, where the bar just overlays it.
    const FULLSCREEN_FIT = {
      youtube: ['#full-bleed-container', '#player-full-bleed-container'],
    };
    let fitted = []; // elements carrying our inline height

    function fitFullscreen() {
      const rootFs = document.fullscreenElement === document.documentElement;
      let changed = false;
      if (!rootFs) {
        for (const node of fitted) {
          node.style.removeProperty('height');
          node.style.removeProperty('max-height');
          changed = true;
        }
        fitted = [];
      } else {
        const value = `calc(100vh - ${barH}px)`;
        for (const sel of FULLSCREEN_FIT[site] || []) {
          const node = document.querySelector(sel);
          if (!node || node.style.getPropertyValue('height') === value) continue;
          node.style.setProperty('height', value, 'important');
          node.style.setProperty('max-height', 'none', 'important');
          if (!fitted.includes(node)) fitted.push(node);
          changed = true;
        }
      }
      if (changed) window.dispatchEvent(new Event('resize'));
    }

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
      updateExtendButton();

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
  }
})();
