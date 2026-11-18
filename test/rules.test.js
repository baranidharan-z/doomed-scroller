'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const DS = require('../shared.js');

const MIN = 60 * 1000;
const CFG = {
  baseMinutes: 15,
  extendMinutes: 5,
  maxExtensions: 3,
  extendCooldownMs: 2 * MIN,
};
// Local noon on a fixed day, so endOfDay is unambiguous.
const NOW = new Date(2026, 10, 18, 12, 0, 0).getTime();
const COOLED = NOW - 2 * MIN; // a warning that started exactly one cool-off ago

function rec(over = {}) {
  return { ...DS.emptyRecord(), ...over };
}

// ---- sites -----------------------------------------------------------------

test('siteForHost maps known hosts and subdomains', () => {
  assert.equal(DS.siteForHost('www.youtube.com'), 'youtube');
  assert.equal(DS.siteForHost('m.youtube.com'), 'youtube');
  assert.equal(DS.siteForHost('old.reddit.com'), 'reddit');
  assert.equal(DS.siteForHost('www.linkedin.com'), 'linkedin');
});

test('siteForHost rejects lookalike hosts', () => {
  assert.equal(DS.siteForHost('notyoutube.com'), null);
  assert.equal(DS.siteForHost('reddit.com.evil.io'), null);
});

test('siteForHost also matches sites added in settings, keyed by domain', () => {
  assert.equal(DS.siteForHost('www.instagram.com', ['instagram.com']), 'instagram.com');
  assert.equal(DS.siteForHost('instagram.com', ['instagram.com']), 'instagram.com');
  assert.equal(DS.siteForHost('notinstagram.com', ['instagram.com']), null);
  assert.equal(DS.siteForHost('www.youtube.com', ['instagram.com']), 'youtube');
});

test('normalizeDomain accepts bare domains, URLs and www', () => {
  assert.equal(DS.normalizeDomain('instagram.com'), 'instagram.com');
  assert.equal(DS.normalizeDomain('  Instagram.COM  '), 'instagram.com');
  assert.equal(DS.normalizeDomain('www.x.com'), 'x.com');
  assert.equal(DS.normalizeDomain('https://www.facebook.com/watch?v=1'), 'facebook.com');
  assert.equal(DS.normalizeDomain('news.ycombinator.com/item?id=1'), 'news.ycombinator.com');
  assert.equal(DS.normalizeDomain('twitch.tv:443'), 'twitch.tv');
});

test('normalizeDomain rejects things that are not domains', () => {
  for (const bad of ['', '   ', 'localhost', 'not a domain', 'http://', '1.2.3.4', 'a..com', '-bad.com', 'x.c', 42, null]) {
    assert.equal(DS.normalizeDomain(bad), null, String(bad));
  }
});

test('addCustomSite adds a new domain', () => {
  const r = DS.addCustomSite([], 'https://www.instagram.com/');
  assert.equal(r.error, null);
  assert.equal(r.domain, 'instagram.com');
  assert.deepEqual(r.sites, ['instagram.com']);
});

test('addCustomSite refuses invalid, built-in, duplicate, and over-limit entries', () => {
  assert.match(DS.addCustomSite([], 'nope').error, /site like/i);
  assert.match(DS.addCustomSite([], 'm.youtube.com').error, /already tracked/i);
  assert.match(DS.addCustomSite(['instagram.com'], 'www.instagram.com').error, /already/i);
  const full = Array.from({ length: DS.MAX_CUSTOM_SITES }, (_, i) => `site${i}.com`);
  assert.match(DS.addCustomSite(full, 'one-more.com').error, /at most/i);
});

test('addCustomSite never changes the list on error', () => {
  const list = ['instagram.com'];
  assert.deepEqual(DS.addCustomSite(list, 'instagram.com').sites, list);
});

test('customSites drops invalid entries, duplicates and sites removed in code', () => {
  assert.deepEqual(DS.customSites(['instagram.com', 'bad', 'instagram.com', 'x.com'], ['x.com']), ['instagram.com']);
  assert.deepEqual(DS.customSites(undefined), []);
  assert.deepEqual(DS.customSites('not a list'), []);
});

test('isKnownSite covers built-in keys and added domains only', () => {
  assert.equal(DS.isKnownSite('youtube', []), true);
  assert.equal(DS.isKnownSite('instagram.com', ['instagram.com']), true);
  assert.equal(DS.isKnownSite('instagram.com', []), false);
  assert.equal(DS.isKnownSite('__proto__', []), false);
});

test('matchPatterns covers the domain and its subdomains', () => {
  assert.deepEqual(DS.matchPatterns('instagram.com'), ['*://instagram.com/*', '*://*.instagram.com/*']);
});

// ---- day keys ----------------------------------------------------------------

test('dayKey uses local date, zero padded', () => {
  assert.equal(DS.dayKey(new Date(2026, 0, 5, 23, 59).getTime()), 'day:2026-01-05');
});

// ---- ticks, warnings, blocks -----------------------------------------------

test('tick accumulates time and stays ok under the limit', () => {
  const r = DS.applyTick(rec(), { activeMs: 2 * MIN }, CFG, NOW);
  assert.equal(r.state, 'ok');
  assert.equal(r.rec.activeMs, 2 * MIN);
});

test('one millisecond under the limit is still ok', () => {
  const r = DS.applyTick(rec({ activeMs: 15 * MIN - 1 }), { activeMs: 0 }, CFG, NOW);
  assert.equal(r.state, 'ok');
});

test('warns exactly at the time limit', () => {
  const r = DS.applyTick(rec({ activeMs: 15 * MIN }), { activeMs: 0 }, CFG, NOW);
  assert.equal(r.state, 'warn');
  assert.equal(r.rec.blockedUntil, 0);
});

test('scroll fields sent by an older content script are ignored', () => {
  const r = DS.applyTick(rec(), { activeMs: 0, screens: 999 }, CFG, NOW);
  assert.equal(r.state, 'ok');
  assert.equal('screens' in r.rec, false);
});

test('hitting the limit after max extensions blocks until local midnight', () => {
  const r = rec({ activeMs: 30 * MIN, extensions: 3 });
  const out = DS.applyTick(r, { activeMs: 0 }, CFG, NOW);
  assert.equal(out.state, 'blocked');
  assert.equal(out.rec.blockedUntil, new Date(2026, 10, 19, 0, 0, 0).getTime());
});

test('blocked record stays blocked regardless of usage', () => {
  const r = rec({ blockedUntil: NOW + MIN });
  assert.equal(DS.applyTick(r, { activeMs: 0 }, CFG, NOW).state, 'blocked');
});

test('negative or non-finite deltas are ignored', () => {
  assert.equal(DS.applyTick(rec(), { activeMs: -5 }, CFG, NOW).rec.activeMs, 0);
  assert.equal(DS.applyTick(rec(), { activeMs: NaN }, CFG, NOW).rec.activeMs, 0);
});

// ---- extensions and the 2-minute cool-off ------------------------------------

test('default extend cool-off is 2 minutes', () => {
  assert.equal(DS.CONFIG.extendCooldownMs, 2 * MIN);
});

test('reaching the limit starts the extend cool-off', () => {
  const r = DS.applyTick(rec({ activeMs: 15 * MIN }), { activeMs: 0 }, CFG, NOW);
  assert.equal(r.rec.warnedAt, NOW);
  assert.equal(DS.extendAvailableAt(r.rec, CFG), NOW + 2 * MIN);
});

test('later ticks keep the original cool-off start', () => {
  const r = DS.applyTick(rec({ activeMs: 15 * MIN, warnedAt: NOW - 30000 }), { activeMs: 1000 }, CFG, NOW);
  assert.equal(r.rec.warnedAt, NOW - 30000);
});

test('extend is refused during the cool-off', () => {
  const ext = DS.applyExtend(rec({ activeMs: 15 * MIN, warnedAt: COOLED + 1 }), 0, CFG, NOW);
  assert.equal(ext.applied, false);
  assert.equal(ext.rec.extensions, 0);
});

test('extend is refused if the cool-off never started', () => {
  const ext = DS.applyExtend(rec({ activeMs: 15 * MIN, warnedAt: 0 }), 0, CFG, NOW);
  assert.equal(ext.applied, false);
});

test('extend works once the cool-off is over, raises the limit and resets the cool-off', () => {
  const ext = DS.applyExtend(rec({ activeMs: 15 * MIN, warnedAt: COOLED }), 0, CFG, NOW);
  assert.equal(ext.applied, true);
  assert.equal(ext.rec.extensions, 1);
  assert.equal(ext.rec.warnedAt, 0);
  assert.deepEqual(DS.thresholds(ext.rec, CFG), { ms: 20 * MIN });
  assert.equal(DS.applyTick(ext.rec, { activeMs: 0 }, CFG, NOW).state, 'ok');
});

test('next warning after an extension starts a fresh cool-off', () => {
  const ext = DS.applyExtend(rec({ activeMs: 15 * MIN, warnedAt: COOLED }), 0, CFG, NOW).rec;
  const later = NOW + 5 * MIN;
  const r = DS.applyTick({ ...ext, activeMs: 20 * MIN }, { activeMs: 0 }, CFG, later);
  assert.equal(r.state, 'warn');
  assert.equal(r.rec.warnedAt, later);
});

test('stale extend (another tab already extended) is not applied twice', () => {
  const r = rec({ activeMs: 15 * MIN, extensions: 1, warnedAt: COOLED });
  const ext = DS.applyExtend(r, 0, CFG, NOW);
  assert.equal(ext.applied, false);
  assert.equal(ext.rec.extensions, 1);
});

test('extend is refused when not in warn state', () => {
  const ext = DS.applyExtend(rec({ warnedAt: COOLED }), 0, CFG, NOW);
  assert.equal(ext.applied, false);
  assert.equal(ext.rec.extensions, 0);
});

test('extend is refused once max extensions are used', () => {
  const r = rec({ activeMs: 30 * MIN, extensions: 3, warnedAt: COOLED });
  const ext = DS.applyExtend(r, 3, CFG, NOW);
  assert.equal(ext.applied, false);
  assert.equal(ext.rec.extensions, 3);
});

// ---- bar growth: gradual from 75% to 35% of window height --------------------

test('bar stays normal below 75% of the allowed time', () => {
  assert.equal(DS.barGrowPercent(0, 0), 0);
  assert.equal(DS.barGrowPercent(0.749, 0), 0);
  assert.equal(DS.barGrowPercent(0.75, 0), 0);
});

test('bar grows linearly from 75% to 100%, reaching 35%', () => {
  assert.equal(DS.barGrowPercent(0.875, 0), 17.5);
  assert.equal(DS.barGrowPercent(1.0, 0), 35);
});

test('bar growth is gradual, not stepped', () => {
  assert.ok(DS.barGrowPercent(0.81, 0) > DS.barGrowPercent(0.80, 0));
  assert.ok(DS.barGrowPercent(0.80, 0) > DS.barGrowPercent(0.79, 0));
});

test('bar growth is capped at 35%', () => {
  assert.equal(DS.barGrowPercent(3.0, 0), 35);
});

test('after any extension the bar stays at 35% even though the fraction dropped', () => {
  assert.equal(DS.barGrowPercent(0.75, 1), 35);
  assert.equal(DS.barGrowPercent(0.10, 3), 35);
});

test('bad input does not grow the bar', () => {
  assert.equal(DS.barGrowPercent(NaN, 0), 0);
});

// ---- colour stage ------------------------------------------------------------

test('no stage below 75%', () => {
  assert.equal(DS.stageFor(0.5, 0), null);
  assert.equal(DS.stageFor(0.749, 0), null);
  assert.equal(DS.stageFor(NaN, 0), null);
});

test('stage by fraction: calm from 75%, caution from 85%, stop from 95%', () => {
  assert.equal(DS.stageFor(0.75, 0), 'calm');
  assert.equal(DS.stageFor(0.849, 0), 'calm');
  assert.equal(DS.stageFor(0.85, 0), 'caution');
  assert.equal(DS.stageFor(0.949, 0), 'caution');
  assert.equal(DS.stageFor(0.95, 0), 'stop');
});

test('after an extension the stage is always stop', () => {
  assert.equal(DS.stageFor(0.2, 1), 'stop');
});
