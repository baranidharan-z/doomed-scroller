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
    // Stop counting active time after this long without scroll/key/mouse input.
    idleMs: 60 * 1000,
    // Keep this many days of history in storage.
    retainDays: 30,
    // Limit changes from the settings page take effect only after this delay.
    coolOffMs: 2 * 60 * 60 * 1000,
    // Opened by the browser after the extension is removed. Must be http(s);
    // a page inside the extension is gone by then. Empty = disabled.
    uninstallUrl: '',
    // Philosophy quotes in the grown bar. false = built-in quotes only, and
    // the extension makes no network requests at all.
    onlineQuotes: true,
    // How long each quote stays up. Long enough to actually read it.
    quoteRotateMs: 60 * 1000,
    // Fetch more quotes when the local pool is older than this, or smaller
    // than quotePoolMin. Failed fetches are retried after quoteRetryMs.
    quoteRefreshMs: 24 * 60 * 60 * 1000,
    quotePoolMin: 20,
    quoteRetryMs: 10 * 60 * 1000,
  };

  // User-editable limits and their allowed ranges (inclusive integers).
  const LIMIT_BOUNDS = {
    baseMinutes: [1, 240],
    extendMinutes: [1, 60],
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
    return { activeMs: 0, extensions: 0, blockedUntil: 0 };
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

  // ---- timer bar growth ---------------------------------------------------
  // Percent of window height the timer bar takes as the limit nears: 0 (normal)
  // below 80%, then 10/15/20/25 at 80/85/90/95%. After any extension the
  // fraction drops (the limit grew), but the bar stays at the maximum.
  const BAR_GROW_MAX = 25;

  function barGrowPercent(fraction, extensions) {
    if (extensions > 0) return BAR_GROW_MAX;
    if (!Number.isFinite(fraction) || fraction < 0.8) return 0;
    const step = Math.floor(fraction * 20 + 1e-9); // 16 at 80%, 17 at 85%, ...
    return Math.min(BAR_GROW_MAX, (step - 14) * 5);
  }

  // ---- grown bar: colour stage ----------------------------------------------
  // growPercent: from barGrowPercent. null while the bar is normal size.
  function stageFor(growPercent, extensions) {
    if (!(growPercent > 0)) return null;
    if (extensions > 0 || growPercent >= 25) return 'stop';
    return growPercent >= 15 ? 'caution' : 'calm';
  }

  // ---- grown bar: philosophy quotes -----------------------------------------
  // Shown to read instead of the feed. The background keeps a pool fetched
  // from two free APIs (see background.js); these built-in quotes cover the
  // first moments, offline use, and the APIs being down.
  const FALLBACK_QUOTES = [
    { text: 'The unexamined life is not worth living.', author: 'Socrates' },
    { text: 'It is not that we have a short time to live, but that we waste a lot of it.', author: 'Seneca' },
    { text: 'Waste no more time arguing about what a good man should be. Be one.', author: 'Marcus Aurelius' },
    { text: 'First say to yourself what you would be; and then do what you have to do.', author: 'Epictetus' },
    { text: 'All of humanity\'s problems stem from man\'s inability to sit quietly in a room alone.', author: 'Blaise Pascal' },
    { text: 'Life can only be understood backwards; but it must be lived forwards.', author: 'Soren Kierkegaard' },
    { text: 'He who has a why to live can bear almost any how.', author: 'Friedrich Nietzsche' },
    { text: 'A journey of a thousand miles begins with a single step.', author: 'Lao Tzu' },
    { text: 'No man ever steps in the same river twice.', author: 'Heraclitus' },
    { text: 'Very little is needed to make a happy life; it is all within yourself, in your way of thinking.', author: 'Marcus Aurelius' },
    { text: 'One must imagine Sisyphus happy.', author: 'Albert Camus' },
    { text: 'Man is condemned to be free.', author: 'Jean-Paul Sartre' },
    { text: 'Whereof one cannot speak, thereof one must be silent.', author: 'Ludwig Wittgenstein' },
    { text: 'I think, therefore I am.', author: 'Rene Descartes' },
    { text: 'The only thing I know is that I know nothing.', author: 'Socrates' },
    { text: 'We are what we repeatedly do.', author: 'Will Durant, on Aristotle' },
  ];

  const QUOTE_TEXT_MAX = 300;
  const QUOTE_AUTHOR_MAX = 80;

  // Validates untrusted API data. Returns a clean {text, author} or null.
  function cleanQuote(q) {
    if (!q || typeof q.text !== 'string' || typeof q.author !== 'string') return null;
    const text = q.text.replace(/\s+/g, ' ').trim();
    const author = q.author.replace(/\s+/g, ' ').trim();
    if (text.length < 8 || text.length > QUOTE_TEXT_MAX) return null;
    if (!author || author.length > QUOTE_AUTHOR_MAX) return null;
    if (/[<>]/.test(text) || /[<>]/.test(author)) return null; // looks like markup
    return { text, author };
  }

  // https://philosophyapi.pythonanywhere.com/api/ideas/?format=json&page=N
  // -> { count, results: [{ id, quote, author }] }
  function parsePhilosophyApi(json) {
    if (!json || !Array.isArray(json.results)) return [];
    return json.results.map((r) => cleanQuote({ text: r && r.quote, author: r && r.author })).filter(Boolean);
  }

  // https://www.stoic-quotes.com/api/quotes?num=N -> [{ text, author }]
  function parseStoic(json) {
    if (!Array.isArray(json)) return [];
    return json.map(cleanQuote).filter(Boolean);
  }

  // Appends new quotes, drops duplicates (case-insensitive text), keeps the
  // newest `max`.
  function mergePool(existing, incoming, max = 200) {
    const seen = new Set();
    const out = [];
    for (const q of [...(existing || []), ...(incoming || [])]) {
      const key = q.text.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(q);
    }
    return out.slice(-max);
  }

  // Stored shape: { items: [{text, author}], fetchedAt, attemptAt }
  function needsRefill(stored, now, cfg) {
    if (!cfg.onlineQuotes) return false;
    const s = stored || {};
    if (now - (s.attemptAt || 0) < cfg.quoteRetryMs) return false;
    const items = Array.isArray(s.items) ? s.items : [];
    return items.length < cfg.quotePoolMin || now - (s.fetchedAt || 0) > cfg.quoteRefreshMs;
  }

  // Same quote in every tab at the same moment; changes every quoteRotateMs.
  function pickQuote(pool, now, rotateMs = CONFIG.quoteRotateMs) {
    if (!pool || !pool.length) return null;
    return pool[Math.floor(now / rotateMs) % pool.length];
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
    thresholds, stateOf, applyTick, applyExtend, barGrowPercent,
    stageFor, FALLBACK_QUOTES, cleanQuote, parsePhilosophyApi, parseStoic,
    mergePool, needsRefill, pickQuote,
    validateLimits, effectiveConfig, resolveSettings, proposeLimits, cancelPending,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = DS;
  else root.DS = DS;
})(typeof self !== 'undefined' ? self : globalThis);
