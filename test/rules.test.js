'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const DS = require('../shared.js');

const CFG = {
  baseMinutes: 15,
  baseScreens: 30,
  extendMinutes: 5,
  extendScreens: 10,
  maxExtensions: 3,
};
const MIN = 60 * 1000;
// Local noon on a fixed day, so endOfDay is unambiguous.
const NOW = new Date(2026, 10, 18, 12, 0, 0).getTime();

function rec(over = {}) {
  return { ...DS.emptyRecord(), ...over };
}

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

test('dayKey uses local date, zero padded', () => {
  assert.equal(DS.dayKey(new Date(2026, 0, 5, 23, 59).getTime()), 'day:2026-01-05');
});

test('tick accumulates deltas and stays ok under thresholds', () => {
  const r = DS.applyTick(rec(), { activeMs: 2 * MIN, screens: 4 }, CFG, NOW);
  assert.equal(r.state, 'ok');
  assert.equal(r.rec.activeMs, 2 * MIN);
  assert.equal(r.rec.screens, 4);
});

test('time alone over threshold does not warn', () => {
  const r = DS.applyTick(rec({ activeMs: 60 * MIN, screens: 5 }), { activeMs: 0, screens: 0 }, CFG, NOW);
  assert.equal(r.state, 'ok');
});

test('scroll alone over threshold does not warn', () => {
  const r = DS.applyTick(rec({ activeMs: 1 * MIN, screens: 500 }), { activeMs: 0, screens: 0 }, CFG, NOW);
  assert.equal(r.state, 'ok');
});

test('warns exactly at both thresholds', () => {
  const r = DS.applyTick(rec({ activeMs: 15 * MIN, screens: 30 }), { activeMs: 0, screens: 0 }, CFG, NOW);
  assert.equal(r.state, 'warn');
  assert.equal(r.rec.blockedUntil, 0);
});

test('extension raises both thresholds', () => {
  const base = rec({ activeMs: 15 * MIN, screens: 30 });
  const ext = DS.applyExtend(base, 0, CFG, NOW);
  assert.equal(ext.applied, true);
  assert.equal(ext.rec.extensions, 1);
  assert.deepEqual(DS.thresholds(ext.rec, CFG), { ms: 20 * MIN, screens: 40 });
  assert.equal(DS.applyTick(ext.rec, { activeMs: 0, screens: 0 }, CFG, NOW).state, 'ok');
});

test('stale extend (another tab already extended) is not applied twice', () => {
  const r = rec({ activeMs: 15 * MIN, screens: 30, extensions: 1 });
  const ext = DS.applyExtend(r, 0, CFG, NOW);
  assert.equal(ext.applied, false);
  assert.equal(ext.rec.extensions, 1);
});

test('extend is refused when not in warn state', () => {
  const ext = DS.applyExtend(rec(), 0, CFG, NOW);
  assert.equal(ext.applied, false);
  assert.equal(ext.rec.extensions, 0);
});

test('hitting the limit after max extensions blocks until local midnight', () => {
  const r = rec({ activeMs: 30 * MIN, screens: 60, extensions: 3 });
  const out = DS.applyTick(r, { activeMs: 0, screens: 0 }, CFG, NOW);
  assert.equal(out.state, 'blocked');
  assert.equal(out.rec.blockedUntil, new Date(2026, 10, 19, 0, 0, 0).getTime());
});

test('extend is refused once max extensions are used', () => {
  const r = rec({ activeMs: 30 * MIN, screens: 60, extensions: 3 });
  const ext = DS.applyExtend(r, 3, CFG, NOW);
  assert.equal(ext.applied, false);
  assert.equal(ext.rec.extensions, 3);
});

test('blocked record stays blocked regardless of usage', () => {
  const r = rec({ blockedUntil: NOW + MIN });
  assert.equal(DS.applyTick(r, { activeMs: 0, screens: 0 }, CFG, NOW).state, 'blocked');
});

test('negative or non-finite deltas are ignored', () => {
  const r = DS.applyTick(rec(), { activeMs: -5, screens: NaN }, CFG, NOW);
  assert.equal(r.rec.activeMs, 0);
  assert.equal(r.rec.screens, 0);
});
