// Shared config + pure rule logic. Loaded by the content script, the
// background service worker (importScripts), the popup, and node tests.
// Must not touch `chrome.*` at load time.
'use strict';

(function (root) {
  const CONFIG = {
    // Warning fires when BOTH are reached for a site today.
    // For quick manual testing set baseMinutes: 1, baseScreens: 5.
    baseMinutes: 15,
    baseScreens: 30,
    // Each "5 more minutes" raises both limits by this much.
    extendMinutes: 5,
    extendScreens: 10,
    // After this many extensions, the next limit hit blocks until midnight.
    maxExtensions: 3,
    // Stop counting active time after this long without scroll/key/mouse input.
    idleMs: 60 * 1000,
    // Keep this many days of history in storage.
    retainDays: 30,
    // Limit changes from the settings page take effect only after this delay.
    coolOffMs: 2 * 60 * 60 * 1000,
    // Opened by the browser after the extension is removed. Must be http(s);
    // a page inside the extension is gone by then. Empty = disabled.
    uninstallUrl: '',
  };

  // User-editable limits and their allowed ranges (inclusive integers).
  const LIMIT_BOUNDS = {
    baseMinutes: [1, 240],
    baseScreens: [1, 1000],
    extendMinutes: [1, 60],
    extendScreens: [0, 500],
    maxExtensions: [0, 10],
  };

  const SITES = {
    youtube: 'youtube.com',
    reddit: 'reddit.com',
    linkedin: 'linkedin.com',
  };

  function siteForHost(host) {
    for (const [site, domain] of Object.entries(SITES)) {
      if (host === domain || host.endsWith('.' + domain)) return site;
    }
    return null;
  }

  function pad(n) {
    return String(n).padStart(2, '0');
  }

  function dayKey(now) {
    const d = new Date(now);
    return `day:${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  function endOfDay(now) {
    const d = new Date(now);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, 0, 0).getTime();
  }

  function emptyRecord() {
    return { activeMs: 0, screens: 0, extensions: 0, blockedUntil: 0 };
  }

  function thresholds(rec, cfg) {
    return {
      ms: (cfg.baseMinutes + rec.extensions * cfg.extendMinutes) * 60 * 1000,
      screens: cfg.baseScreens + rec.extensions * cfg.extendScreens,
    };
  }

  function overLimit(rec, cfg) {
    const t = thresholds(rec, cfg);
    return rec.activeMs >= t.ms && rec.screens >= t.screens;
  }

  function stateOf(rec, cfg, now) {
    if (rec.blockedUntil && now < rec.blockedUntil) return 'blocked';
    return overLimit(rec, cfg) ? 'warn' : 'ok';
  }

  function cleanDelta(x) {
    return Number.isFinite(x) && x > 0 ? x : 0;
  }

  // Returns a new record; never mutates the input.
  function applyTick(rec, delta, cfg, now) {
    const next = {
      ...rec,
      activeMs: rec.activeMs + cleanDelta(delta.activeMs),
      screens: rec.screens + cleanDelta(delta.screens),
    };
    let state = stateOf(next, cfg, now);
    if (state === 'warn' && next.extensions >= cfg.maxExtensions) {
      next.blockedUntil = endOfDay(now);
      state = 'blocked';
    }
    return { rec: next, state };
  }

  // seenExtensions: the count the requesting tab saw when it showed the
  // warning. If another tab already extended, this request is stale and is
  // dropped so one warning can't burn two extensions.
  function applyExtend(rec, seenExtensions, cfg, now) {
    const ok =
      stateOf(rec, cfg, now) === 'warn' &&
      rec.extensions < cfg.maxExtensions &&
      rec.extensions === seenExtensions;
    if (!ok) return { rec, applied: false };
    return { rec: { ...rec, extensions: rec.extensions + 1 }, applied: true };
  }

  // ---- settings with cool-off ---------------------------------------------
  // Stored shape: { active: {limits} | {}, pending: {values, effectiveAt} | null }

  function validateLimits(input) {
    const values = {};
    const errors = [];
    for (const [key, [lo, hi]] of Object.entries(LIMIT_BOUNDS)) {
      const raw = input ? input[key] : undefined;
      const n = raw === '' || raw === null || raw === undefined ? NaN : Number(raw);
      if (!Number.isInteger(n) || n < lo || n > hi) {
        errors.push({ key, message: `${key} must be a whole number from ${lo} to ${hi}` });
      } else {
        values[key] = n;
      }
    }
    return errors.length ? { values: null, errors } : { values, errors };
  }

  function normalizeSettings(stored) {
    return {
      active: (stored && stored.active) || {},
      pending: (stored && stored.pending) || null,
    };
  }

  function effectiveConfig(settings, defaults) {
    return { ...(defaults || CONFIG), ...normalizeSettings(settings).active };
  }

  // Promotes a due pending change. `promoted` tells the caller to persist.
  function resolveSettings(stored, now) {
    let settings = normalizeSettings(stored);
    let promoted = false;
    if (settings.pending && now >= settings.pending.effectiveAt) {
      settings = { active: { ...settings.pending.values }, pending: null };
      promoted = true;
    }
    return { settings, cfg: effectiveConfig(settings), promoted };
  }

  // A new proposal replaces any pending one and restarts the cool-off.
  function proposeLimits(stored, input, now) {
    const settings = normalizeSettings(stored);
    const { values, errors } = validateLimits(input);
    if (errors.length) return { settings, errors };
    return {
      settings: { ...settings, pending: { values, effectiveAt: now + CONFIG.coolOffMs } },
      errors,
    };
  }

  function cancelPending(stored) {
    return { ...normalizeSettings(stored), pending: null };
  }

  const DS = {
    CONFIG, SITES, LIMIT_BOUNDS, siteForHost, dayKey, endOfDay, emptyRecord,
    thresholds, stateOf, applyTick, applyExtend,
    validateLimits, effectiveConfig, resolveSettings, proposeLimits, cancelPending,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = DS;
  else root.DS = DS;
})(typeof self !== 'undefined' ? self : globalThis);
