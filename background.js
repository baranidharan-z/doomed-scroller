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
