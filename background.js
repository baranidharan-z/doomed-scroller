// Service worker. Sole writer of chrome.storage.local (usage records and
// settings).
//
// Ownership rule: content scripts and pages never write storage; they send
// messages here. All read-modify-write cycles go through `serialized()` so
// concurrent messages from several tabs can't interleave and lose updates.
//
// MV3 may kill this worker after ~30s idle, so no state lives in memory
// except the in-flight promise chain.
'use strict';

importScripts('shared.js');

const SETTINGS_KEY = 'settings';

let chain = Promise.resolve();
function serialized(fn) {
  const p = chain.then(fn);
  // Keep the chain alive after a failure; the caller still sees the
  // rejection through `p`.
  chain = p.catch(() => {});
  return p;
}

// Call only inside serialized(). Persists a pending change once it is due.
async function loadConfig(now) {
  const got = await chrome.storage.local.get(SETTINGS_KEY);
  const r = DS.resolveSettings(got[SETTINGS_KEY], now);
  if (r.promoted) {
    await chrome.storage.local.set({ [SETTINGS_KEY]: r.settings });
    console.info('[doomed] new limits in effect', r.settings.active);
  }
  return r;
}

async function loadRecord(key, site) {
  const got = await chrome.storage.local.get(key);
  const day = got[key] || {};
  return { day, rec: { ...DS.emptyRecord(), ...(day[site] || {}) } };
}

async function saveRecord(key, day, site, rec) {
  await chrome.storage.local.set({ [key]: { ...day, [site]: rec } });
}

function reply(site, rec, state, cfg) {
  return {
    site,
    state,
    rec,
    thresholds: DS.thresholds(rec, cfg),
    maxExtensions: cfg.maxExtensions,
  };
}

function handleTick(msg) {
  return serialized(async () => {
    const now = Date.now();
    const { cfg } = await loadConfig(now);
    const key = DS.dayKey(now);
    const { day, rec } = await loadRecord(key, msg.site);
    const out = DS.applyTick(rec, msg, cfg, now);
    await saveRecord(key, day, msg.site, out.rec);
    if (out.state === 'blocked' && !rec.blockedUntil) {
      console.info('[doomed] blocked', { site: msg.site, until: new Date(out.rec.blockedUntil).toISOString() });
    }
    return reply(msg.site, out.rec, out.state, cfg);
  });
}

function handleExtend(msg) {
  return serialized(async () => {
    const now = Date.now();
    const { cfg } = await loadConfig(now);
    const key = DS.dayKey(now);
    const { day, rec } = await loadRecord(key, msg.site);
    const out = DS.applyExtend(rec, msg.seenExtensions, cfg, now);
    if (out.applied) {
      await saveRecord(key, day, msg.site, out.rec);
      console.info('[doomed] extended', { site: msg.site, extensions: out.rec.extensions });
    }
    return reply(msg.site, out.rec, DS.stateOf(out.rec, cfg, now), cfg);
  });
}

function settingsReply(settings, cfg, errors) {
  const limits = {};
  for (const k of Object.keys(DS.LIMIT_BOUNDS)) limits[k] = cfg[k];
  return { limits, pending: settings.pending, coolOffMs: DS.CONFIG.coolOffMs, errors: errors || [] };
}

function handleGetSettings() {
  return serialized(async () => {
    const { settings, cfg } = await loadConfig(Date.now());
    return settingsReply(settings, cfg);
  });
}

function handleProposeLimits(msg) {
  return serialized(async () => {
    const now = Date.now();
    const { settings, cfg } = await loadConfig(now);
    const p = DS.proposeLimits(settings, msg.values, now);
    if (!p.errors.length) {
      await chrome.storage.local.set({ [SETTINGS_KEY]: p.settings });
      console.info('[doomed] limits proposed', p.settings.pending);
    }
    return settingsReply(p.settings, cfg, p.errors);
  });
}

function handleCancelPending() {
  return serialized(async () => {
    const { settings, cfg } = await loadConfig(Date.now());
    const next = DS.cancelPending(settings);
    await chrome.storage.local.set({ [SETTINGS_KEY]: next });
    return settingsReply(next, cfg);
  });
}

// ---- philosophy quotes -----------------------------------------------------
// Pool of quotes fetched from two free APIs, stored locally and refreshed about
// once a day. Fetches happen here (not in content scripts) so the page's CORS
// rules don't apply; manifest host_permissions cover both hosts. Nothing about
// the user is sent: these are plain GET requests with no parameters but a page
// number. With CONFIG.onlineQuotes = false no request is ever made.

const QUOTES_KEY = 'quotes';
const FETCH_TIMEOUT_MS = 8000;
const PHILOSOPHYAPI_PAGES = 17; // 254 quotes at 15 per page, as of 2026-11

const QUOTE_SOURCES = [
  {
    name: 'philosophyapi',
    url: () => 'https://philosophyapi.pythonanywhere.com/api/ideas/?format=json&page=' +
      (1 + Math.floor(Math.random() * PHILOSOPHYAPI_PAGES)),
    parse: DS.parsePhilosophyApi,
  },
  {
    name: 'stoic-quotes',
    url: () => 'https://www.stoic-quotes.com/api/quotes?num=20',
    parse: DS.parseStoic,
  },
];

async function fetchJson(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, credentials: 'omit' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

let refilling = false; // in-memory guard; attemptAt in storage survives worker restarts

async function refillQuotes() {
  if (refilling) return;
  refilling = true;
  try {
    const now = Date.now();
    // Claim the attempt first so other tabs' requests don't start another.
    const go = await serialized(async () => {
      const stored = (await chrome.storage.local.get(QUOTES_KEY))[QUOTES_KEY];
      if (!DS.needsRefill(stored, now, DS.CONFIG)) return false;
      await chrome.storage.local.set({ [QUOTES_KEY]: { ...(stored || {}), attemptAt: now } });
      return true;
    });
    if (!go) return;

    const results = await Promise.allSettled(QUOTE_SOURCES.map(async (src) => src.parse(await fetchJson(src.url()))));
    const incoming = [];
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') incoming.push(...r.value);
      else console.warn('[doomed] quote source failed', { source: QUOTE_SOURCES[i].name, error: String(r.reason) });
    });

    await serialized(async () => {
      const stored = (await chrome.storage.local.get(QUOTES_KEY))[QUOTES_KEY] || {};
      const items = DS.mergePool(stored.items, incoming);
      await chrome.storage.local.set({
        [QUOTES_KEY]: { items, attemptAt: now, fetchedAt: incoming.length ? now : stored.fetchedAt || 0 },
      });
      console.info('[doomed] quotes refreshed', { added: incoming.length, pool: items.length });
    });
  } finally {
    refilling = false;
  }
}

function handleGetQuote() {
  return serialized(async () => {
    const stored = (await chrome.storage.local.get(QUOTES_KEY))[QUOTES_KEY];
    // Top up in the background; the reply doesn't wait for the network.
    refillQuotes().catch((e) => console.error('[doomed] quote refill failed', e));
    const pool = stored && Array.isArray(stored.items) ? stored.items : [];
    return { quote: DS.pickQuote(pool, Date.now()) };
  });
}

async function pruneOldDays() {
  const all = await chrome.storage.local.get(null);
  const cutoff = DS.dayKey(Date.now() - DS.CONFIG.retainDays * 24 * 60 * 60 * 1000);
  // dayKey strings are zero-padded, so lexical order == date order.
  const stale = Object.keys(all).filter((k) => k.startsWith('day:') && k < cutoff);
  if (stale.length) await chrome.storage.local.remove(stale);
}

function onStart() {
  pruneOldDays().catch((e) => console.error('[doomed] prune failed', e));
  // An empty string clears any previously set URL.
  chrome.runtime.setUninstallURL(DS.CONFIG.uninstallUrl)
    .catch((e) => console.error('[doomed] setUninstallURL failed', { url: DS.CONFIG.uninstallUrl }, e));
}
chrome.runtime.onInstalled.addListener(onStart);
chrome.runtime.onStartup.addListener(onStart);

const HANDLERS = {
  tick: (msg) => (DS.SITES[msg.site] ? handleTick(msg) : null),
  extend: (msg) => (DS.SITES[msg.site] ? handleExtend(msg) : null),
  getSettings: handleGetSettings,
  proposeLimits: handleProposeLimits,
  cancelPending: handleCancelPending,
  getQuote: handleGetQuote,
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'closeTab') {
    if (sender.tab?.id !== undefined) chrome.tabs.remove(sender.tab.id);
    return false;
  }

  const handler = HANDLERS[msg?.type];
  const work = handler ? handler(msg) : null;
  if (!work) return false;

  work.then(sendResponse, (err) => {
    console.error('[doomed] message failed', { type: msg.type, site: msg.site }, err);
    sendResponse({ error: String(err) });
  });
  return true; // async sendResponse
});
