// Shared config + pure rule logic. Loaded by the content script, the
// background service worker (importScripts), the popup, and node tests.
// Must not touch `chrome.*` at load time.
'use strict';

(function (root) {
  const CONFIG = {
    // Warning fires after this much active time on a site today.
    // For quick manual testing set baseMinutes: 1.
    baseMinutes: 15,
    // Each "5 more minutes" raises the limit by this much.
    extendMinutes: 5,
    // After this many extensions, the next limit hit blocks until midnight.
    maxExtensions: 3,
    // When the warning appears, "more minutes" stays locked this long, so
    // extending is a decision, not a reflex.
    extendCooldownMs: 2 * 60 * 1000,
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
    extendMinutes: [1, 60],
    maxExtensions: [0, 10],
  };

  // Built-in sites. More can be added from the settings page (stored as
  // `customSites` and keyed by their domain); they can't be removed there.
  const SITES = {
    youtube: 'youtube.com',
    reddit: 'reddit.com',
    linkedin: 'linkedin.com',
  };

  // To stop tracking a site that was added in settings, list its domain here
  // and reload the extension. Removal is deliberately only possible in code.
  const SITE_REMOVALS = [];

  const MAX_CUSTOM_SITES = 20;

  function hostMatches(host, domain) {
    return host === domain || host.endsWith('.' + domain);
  }

  // Built-in sites map to their key ('youtube'); added sites to their domain.
  function siteForHost(host, custom = []) {
    for (const [site, domain] of Object.entries(SITES)) {
      if (hostMatches(host, domain)) return site;
    }
    for (const domain of custom) {
      if (hostMatches(host, domain)) return domain;
    }
    return null;
  }

  // "https://www.Instagram.com/explore" -> "instagram.com"; null if not a domain.
  const DOMAIN_RE = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

  function normalizeDomain(input) {
    if (typeof input !== 'string') return null;
    let s = input.trim().toLowerCase();
    s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, ''); // scheme
    s = s.split(/[/?#]/)[0]; // path, query, fragment
    s = s.replace(/:\d+$/, ''); // port
    s = s.replace(/^www\./, '');
    return DOMAIN_RE.test(s) ? s : null;
  }

  // Stored list -> clean list: valid, unique, and not removed in code.
  function customSites(stored, removals = SITE_REMOVALS) {
    if (!Array.isArray(stored)) return [];
    const out = [];
    for (const raw of stored) {
      const d = normalizeDomain(raw);
      if (d && !removals.includes(d) && !out.includes(d)) out.push(d);
    }
    return out;
  }

  function addCustomSite(list, input) {
    const sites = customSites(list);
    const domain = normalizeDomain(input);
    if (!domain) return { sites, domain: null, error: 'Enter a site like instagram.com' };
    if (siteForHost(domain)) return { sites, domain, error: `${domain} is already tracked (built in)` };
    if (sites.some((d) => hostMatches(domain, d))) return { sites, domain, error: `${domain} is already added` };
    if (sites.length >= MAX_CUSTOM_SITES) return { sites, domain, error: `You can add at most ${MAX_CUSTOM_SITES} sites` };
    return { sites: [...sites, domain], domain, error: null };
  }

  function isKnownSite(site, custom) {
    return Object.prototype.hasOwnProperty.call(SITES, site) || custom.includes(site);
  }

  // Patterns for permission requests and dynamic content scripts.
  function matchPatterns(domain) {
    return [`*://${domain}/*`, `*://*.${domain}/*`];
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

  // warnedAt: when the current warning started (0 = none); the extend
  // cool-off runs from here.
  function emptyRecord() {
    return { activeMs: 0, extensions: 0, blockedUntil: 0, warnedAt: 0 };
  }

  function thresholds(rec, cfg) {
    return { ms: (cfg.baseMinutes + rec.extensions * cfg.extendMinutes) * 60 * 1000 };
  }

  function overLimit(rec, cfg) {
    return rec.activeMs >= thresholds(rec, cfg).ms;
  }

  function stateOf(rec, cfg, now) {
    if (rec.blockedUntil && now < rec.blockedUntil) return 'blocked';
    return overLimit(rec, cfg) ? 'warn' : 'ok';
  }

  function cleanDelta(x) {
    return Number.isFinite(x) && x > 0 ? x : 0;
  }

  // Returns a new record; never mutates the input. Only the known fields are
  // kept, so data from the older scroll-based version is dropped on write.
  function applyTick(rec, delta, cfg, now) {
    const next = {
      activeMs: rec.activeMs + cleanDelta(delta.activeMs),
      extensions: rec.extensions,
      blockedUntil: rec.blockedUntil,
      warnedAt: rec.warnedAt || 0,
    };
    let state = stateOf(next, cfg, now);
    if (state === 'warn' && next.extensions >= cfg.maxExtensions) {
      next.blockedUntil = endOfDay(now);
      state = 'blocked';
    }
    if (state === 'warn' && !next.warnedAt) next.warnedAt = now; // cool-off starts
    return { rec: next, state };
  }

  // When "more minutes" unlocks for the current warning; 0 if no warning.
  function extendAvailableAt(rec, cfg) {
    return rec.warnedAt ? rec.warnedAt + cfg.extendCooldownMs : 0;
  }

  // seenExtensions: the count the requesting tab saw when it showed the
  // warning. If another tab already extended, this request is stale and is
  // dropped so one warning can't burn two extensions. Refused until the
  // cool-off for this warning has passed.
  function applyExtend(rec, seenExtensions, cfg, now) {
    const ok =
      stateOf(rec, cfg, now) === 'warn' &&
      rec.extensions < cfg.maxExtensions &&
      rec.extensions === seenExtensions &&
      rec.warnedAt > 0 &&
      now >= extendAvailableAt(rec, cfg);
    if (!ok) return { rec, applied: false };
    return { rec: { ...rec, extensions: rec.extensions + 1, warnedAt: 0 }, applied: true };
  }

  // ---- timer bar growth ---------------------------------------------------
  // Percent of window height the timer bar takes, by fraction of the day's
  // allowance used: 0 (normal) up to 75%, then rising smoothly to 35% at
  // 100%. After any extension the fraction drops (the limit grew), but the
  // bar stays at the maximum.
  const BAR_GROW_START = 0.75;
  const BAR_GROW_MAX = 35;

  function barGrowPercent(fraction, extensions) {
    if (extensions > 0) return BAR_GROW_MAX;
    if (!Number.isFinite(fraction) || fraction <= BAR_GROW_START) return 0;
    return Math.min(BAR_GROW_MAX, ((fraction - BAR_GROW_START) / (1 - BAR_GROW_START)) * BAR_GROW_MAX);
  }

  // ---- bar colour stage -----------------------------------------------------
  // null (plain) below 75%, calm from 75%, caution from 85%, stop from 95%
  // and after any extension.
  function stageFor(fraction, extensions) {
    if (extensions > 0) return 'stop';
    if (!Number.isFinite(fraction) || fraction < BAR_GROW_START) return null;
    if (fraction < 0.85) return 'calm';
    return fraction < 0.95 ? 'caution' : 'stop';
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
    thresholds, stateOf, applyTick, applyExtend, extendAvailableAt, barGrowPercent,
    stageFor, SITE_REMOVALS, MAX_CUSTOM_SITES, normalizeDomain, customSites,
    addCustomSite, isKnownSite, matchPatterns,
    validateLimits, effectiveConfig, resolveSettings, proposeLimits, cancelPending,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = DS;
  else root.DS = DS;
})(typeof self !== 'undefined' ? self : globalThis);
