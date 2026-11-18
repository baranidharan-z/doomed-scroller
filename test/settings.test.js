'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const DS = require('../shared.js');

const H = 60 * 60 * 1000;
const NOW = new Date(2026, 10, 18, 12, 0, 0).getTime();
const GOOD = { baseMinutes: 20, baseScreens: 40, extendMinutes: 5, extendScreens: 10, maxExtensions: 2 };

test('cool-off is 2 hours', () => {
  assert.equal(DS.CONFIG.coolOffMs, 2 * H);
});

test('validateLimits accepts in-range integers, including numeric strings from a form', () => {
  const r = DS.validateLimits({ ...GOOD, baseMinutes: '25' });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.values, { ...GOOD, baseMinutes: 25 });
});

test('validateLimits rejects out-of-range, fractional and missing values', () => {
  const r = DS.validateLimits({ ...GOOD, baseMinutes: 0, baseScreens: 2.5, maxExtensions: undefined });
  assert.equal(r.values, null);
  assert.deepEqual(r.errors.map((e) => e.key).sort(), ['baseMinutes', 'baseScreens', 'maxExtensions']);
});

test('validateLimits drops unknown keys', () => {
  const r = DS.validateLimits({ ...GOOD, coolOffMs: 0 });
  assert.deepEqual(r.values, GOOD);
});

test('empty storage resolves to code defaults with nothing pending', () => {
  const r = DS.resolveSettings(undefined, NOW);
  assert.equal(r.cfg.baseMinutes, DS.CONFIG.baseMinutes);
  assert.equal(r.settings.pending, null);
  assert.equal(r.promoted, false);
});

test('proposal is pending for 2h and does not change effective limits', () => {
  const p = DS.proposeLimits(undefined, GOOD, NOW);
  assert.deepEqual(p.errors, []);
  assert.equal(p.settings.pending.effectiveAt, NOW + 2 * H);
  const r = DS.resolveSettings(p.settings, NOW + 2 * H - 1);
  assert.equal(r.cfg.baseMinutes, DS.CONFIG.baseMinutes);
  assert.equal(r.promoted, false);
});

test('proposal takes effect exactly at effectiveAt and clears pending', () => {
  const p = DS.proposeLimits(undefined, GOOD, NOW);
  const r = DS.resolveSettings(p.settings, NOW + 2 * H);
  assert.equal(r.promoted, true);
  assert.equal(r.cfg.baseMinutes, 20);
  assert.equal(r.cfg.maxExtensions, 2);
  assert.equal(r.settings.pending, null);
  assert.deepEqual(r.settings.active, GOOD);
});

test('a new proposal replaces the pending one and restarts the clock', () => {
  const first = DS.proposeLimits(undefined, GOOD, NOW);
  const second = DS.proposeLimits(first.settings, { ...GOOD, baseMinutes: 60 }, NOW + 1 * H);
  assert.equal(second.settings.pending.effectiveAt, NOW + 3 * H);
  assert.equal(second.settings.pending.values.baseMinutes, 60);
  assert.equal(DS.resolveSettings(second.settings, NOW + 2 * H).cfg.baseMinutes, DS.CONFIG.baseMinutes);
});

test('invalid proposal leaves stored settings untouched', () => {
  const first = DS.proposeLimits(undefined, GOOD, NOW);
  const bad = DS.proposeLimits(first.settings, { ...GOOD, baseMinutes: -1 }, NOW + H);
  assert.equal(bad.errors.length, 1);
  assert.deepEqual(bad.settings, first.settings);
});

test('cancelPending keeps active limits and drops the pending change', () => {
  const p = DS.proposeLimits(undefined, GOOD, NOW);
  const c = DS.cancelPending(p.settings);
  assert.equal(c.pending, null);
  assert.equal(DS.resolveSettings(c, NOW + 3 * H).cfg.baseMinutes, DS.CONFIG.baseMinutes);
});

test('once active, editing code defaults does not change saved limits', () => {
  const p = DS.proposeLimits(undefined, GOOD, NOW);
  const { settings } = DS.resolveSettings(p.settings, NOW + 2 * H);
  const cfg = DS.effectiveConfig(settings, { ...DS.CONFIG, baseMinutes: 999 });
  assert.equal(cfg.baseMinutes, 20);
});
