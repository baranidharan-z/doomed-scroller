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
const SITES_KEY = 'customSites'; // domains added in settings
const SCRIPT_ID = 'doomed-custom-sites'; // dynamic content script for them

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
    extendMinutes: cfg.extendMinutes,
    extendAt: DS.extendAvailableAt(rec, cfg), // "more minutes" unlocks here
  };
}

async function loadCustomSites() {
  const got = await chrome.storage.local.get(SITES_KEY);
  return DS.customSites(got[SITES_KEY]);
}

// Messages name a site; only built-in or added sites may write records.
async function isTracked(site) {
  return typeof site === 'string' && DS.isKnownSite(site, await loadCustomSites());
}

function handleTick(msg) {
  return serialized(async () => {
    if (!(await isTracked(msg.site))) return null;
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
    if (!(await isTracked(msg.site))) return null;
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

// ---- sites added in settings ------------------------------------------------
// The settings page requests host permission for the domain (it must, from
// the click), then sends addSite. We store the domain and register the page
// script for every added site we have permission for. Sites are removed only
// by listing them in SITE_REMOVALS (shared.js); onStart drops them here.

// Idempotent: replaces the registration with the current list.
async function syncContentScripts() {
  const sites = await loadCustomSites();
  const granted = [];
  for (const d of sites) {
    if (await chrome.permissions.contains({ origins: DS.matchPatterns(d) })) granted.push(d);
  }
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [SCRIPT_ID] });
  if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] });
  if (granted.length) {
    await chrome.scripting.registerContentScripts([{
      id: SCRIPT_ID,
      matches: granted.flatMap(DS.matchPatterns),
      js: ['shared.js', 'content.js'],
      runAt: 'document_idle',
      persistAcrossSessions: true,
    }]);
  }
  console.info('[doomed] custom sites registered', { sites: granted });
}

// Applies SITE_REMOVALS to the stored list and releases their site access.
async function applySiteRemovals() {
  const removed = await serialized(async () => {
    const raw = (await chrome.storage.local.get(SITES_KEY))[SITES_KEY];
    const all = DS.customSites(raw, []);
    const kept = DS.customSites(raw);
    if (kept.length !== all.length || !Array.isArray(raw) || raw.length !== kept.length) {
      await chrome.storage.local.set({ [SITES_KEY]: kept });
    }
    return all.filter((d) => !kept.includes(d));
  });
  for (const d of removed) {
    await chrome.permissions.remove({ origins: DS.matchPatterns(d) });
    console.info('[doomed] site removed in code', { site: d });
  }
}

function handleGetSites() {
  return loadCustomSites().then((custom) => ({ builtIn: Object.values(DS.SITES), custom }));
}

// Replies { added, sites } or { message, sites } (message is shown to the user).
async function handleAddSite(msg) {
  const res = await serialized(async () => {
    const stored = (await chrome.storage.local.get(SITES_KEY))[SITES_KEY];
    const r = DS.addCustomSite(stored, msg.input);
    if (r.error) return { message: r.error, sites: r.sites };
    if (!(await chrome.permissions.contains({ origins: DS.matchPatterns(r.domain) }))) {
      return { message: `Access to ${r.domain} wasn't granted, so it can't be tracked.`, sites: r.sites };
    }
    await chrome.storage.local.set({ [SITES_KEY]: r.sites });
    console.info('[doomed] site added', { site: r.domain });
    return { added: r.domain, sites: r.sites };
  });
  if (res.added) await syncContentScripts();
  return res;
}

function onStart() {
  pruneOldDays().catch((e) => console.error('[doomed] prune failed', e));
  applySiteRemovals()
    .then(syncContentScripts)
    .catch((e) => console.error('[doomed] syncing custom sites failed', e));
  // An empty string clears any previously set URL.
  chrome.runtime.setUninstallURL(DS.CONFIG.uninstallUrl)
    .catch((e) => console.error('[doomed] setUninstallURL failed', { url: DS.CONFIG.uninstallUrl }, e));
}
chrome.runtime.onInstalled.addListener(onStart);
chrome.runtime.onStartup.addListener(onStart);
// Site access revoked in the browser's own settings: stop injecting there.
chrome.permissions.onRemoved.addListener(() => {
  syncContentScripts().catch((e) => console.error('[doomed] syncing custom sites failed', e));
});

const HANDLERS = {
  tick: handleTick,
  extend: handleExtend,
  getSettings: handleGetSettings,
  proposeLimits: handleProposeLimits,
  cancelPending: handleCancelPending,
  getSites: handleGetSites,
  addSite: handleAddSite,
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
