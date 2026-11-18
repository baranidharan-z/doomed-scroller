'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const DS = require('../shared.js');

const CFG = {
  baseMinutes: 15,
  extendMinutes: 5,
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

test('tick accumulates time and stays ok under the limit', () => {
  const r = DS.applyTick(rec(), { activeMs: 2 * MIN }, CFG, NOW);
  assert.equal(r.state, 'ok');
  assert.equal(r.rec.activeMs, 2 * MIN);
});

test('one millisecond under the limit is still ok', () => {
  const r = DS.applyTick(rec({ activeMs: 15 * MIN - 1 }), { activeMs: 0 }, CFG, NOW);
  assert.equal(r.state, 'ok');
});

test('warns exactly at the time limit, with no scrolling at all', () => {
  const r = DS.applyTick(rec({ activeMs: 15 * MIN }), { activeMs: 0 }, CFG, NOW);
  assert.equal(r.state, 'warn');
  assert.equal(r.rec.blockedUntil, 0);
});

test('scroll fields sent by an older content script are ignored', () => {
  const r = DS.applyTick(rec(), { activeMs: 0, screens: 999 }, CFG, NOW);
  assert.equal(r.state, 'ok');
  assert.equal('screens' in r.rec, false);
});

test('extension raises the time limit', () => {
  const ext = DS.applyExtend(rec({ activeMs: 15 * MIN }), 0, CFG, NOW);
  assert.equal(ext.applied, true);
  assert.equal(ext.rec.extensions, 1);
  assert.deepEqual(DS.thresholds(ext.rec, CFG), { ms: 20 * MIN });
  assert.equal(DS.applyTick(ext.rec, { activeMs: 0 }, CFG, NOW).state, 'ok');
});

test('stale extend (another tab already extended) is not applied twice', () => {
  const r = rec({ activeMs: 15 * MIN, extensions: 1 });
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
  const r = rec({ activeMs: 30 * MIN, extensions: 3 });
  const out = DS.applyTick(r, { activeMs: 0 }, CFG, NOW);
  assert.equal(out.state, 'blocked');
  assert.equal(out.rec.blockedUntil, new Date(2026, 10, 19, 0, 0, 0).getTime());
});

test('extend is refused once max extensions are used', () => {
  const r = rec({ activeMs: 30 * MIN, extensions: 3 });
  const ext = DS.applyExtend(r, 3, CFG, NOW);
  assert.equal(ext.applied, false);
  assert.equal(ext.rec.extensions, 3);
});

test('blocked record stays blocked regardless of usage', () => {
  const r = rec({ blockedUntil: NOW + MIN });
  assert.equal(DS.applyTick(r, { activeMs: 0 }, CFG, NOW).state, 'blocked');
});

test('negative or non-finite deltas are ignored', () => {
  assert.equal(DS.applyTick(rec(), { activeMs: -5 }, CFG, NOW).rec.activeMs, 0);
  assert.equal(DS.applyTick(rec(), { activeMs: NaN }, CFG, NOW).rec.activeMs, 0);
});

// ---- bar growth near the limit ---------------------------------------------

test('bar stays normal below 80% of the allowed time', () => {
  assert.equal(DS.barGrowPercent(0, 0), 0);
  assert.equal(DS.barGrowPercent(0.799, 0), 0);
});

test('bar grows in 5% steps from 80%: 10, 15, 20, 25', () => {
  assert.equal(DS.barGrowPercent(0.80, 0), 10);
  assert.equal(DS.barGrowPercent(0.849, 0), 10);
  assert.equal(DS.barGrowPercent(0.85, 0), 15);
  assert.equal(DS.barGrowPercent(0.90, 0), 20);
  assert.equal(DS.barGrowPercent(0.95, 0), 25);
});

test('bar growth is capped at 25%', () => {
  assert.equal(DS.barGrowPercent(1.0, 0), 25);
  assert.equal(DS.barGrowPercent(3.0, 0), 25);
});

test('after any extension the bar stays at 25% even though the fraction dropped', () => {
  assert.equal(DS.barGrowPercent(0.75, 1), 25);
  assert.equal(DS.barGrowPercent(0.10, 3), 25);
});

test('bad input does not grow the bar', () => {
  assert.equal(DS.barGrowPercent(NaN, 0), 0);
});

// ---- stages and philosophy quotes in the grown bar ------------------------

test('no stage while the bar is normal size', () => {
  assert.equal(DS.stageFor(0, 0), null);
});

test('stage follows bar growth: calm, caution, stop', () => {
  assert.equal(DS.stageFor(10, 0), 'calm');
  assert.equal(DS.stageFor(15, 0), 'caution');
  assert.equal(DS.stageFor(20, 0), 'caution');
  assert.equal(DS.stageFor(25, 0), 'stop');
});

test('after an extension the stage is always stop', () => {
  assert.equal(DS.stageFor(25, 1), 'stop');
});

test('built-in quotes are all valid', () => {
  assert.ok(DS.FALLBACK_QUOTES.length >= 10);
  for (const q of DS.FALLBACK_QUOTES) assert.deepEqual(DS.cleanQuote(q), q);
});

test('pickQuote is stable within a rotation window and rotates after', () => {
  const pool = DS.FALLBACK_QUOTES;
  const R = DS.CONFIG.quoteRotateMs;
  const t0 = Math.floor(NOW / R) * R;
  const a = DS.pickQuote(pool, t0);
  assert.deepEqual(DS.pickQuote(pool, t0 + R - 1), a);
  assert.notDeepEqual(DS.pickQuote(pool, t0 + R), a);
});

test('pickQuote on an empty pool returns null', () => {
  assert.equal(DS.pickQuote([], NOW), null);
});

test('quote rotation gives time to read (at least 45s)', () => {
  assert.ok(DS.CONFIG.quoteRotateMs >= 45 * 1000);
});

test('cleanQuote trims, collapses whitespace and keeps text + author', () => {
  assert.deepEqual(DS.cleanQuote({ text: '  Know   thyself. ', author: ' Socrates ' }), { text: 'Know thyself.', author: 'Socrates' });
});

test('cleanQuote rejects missing, too short, too long, or HTML-looking quotes', () => {
  assert.equal(DS.cleanQuote(null), null);
  assert.equal(DS.cleanQuote({ text: 'Hi', author: 'A' }), null);
  assert.equal(DS.cleanQuote({ text: 'x'.repeat(301), author: 'A' }), null);
  assert.equal(DS.cleanQuote({ text: 'A fine thought indeed.', author: '' }), null);
  assert.equal(DS.cleanQuote({ text: '<script>alert(1)</script> nope', author: 'A' }), null);
  assert.equal(DS.cleanQuote({ text: 42, author: 'A' }), null);
});

test('parsePhilosophyApi maps results to text/author and drops bad entries', () => {
  const json = { count: 2, results: [
    { id: 1, quote: 'I think, therefore I am', author: 'Rene Descartes' },
    { id: 2, quote: '', author: 'Nobody' },
  ] };
  assert.deepEqual(DS.parsePhilosophyApi(json), [{ text: 'I think, therefore I am', author: 'Rene Descartes' }]);
  assert.deepEqual(DS.parsePhilosophyApi({ nope: true }), []);
});

test('parseStoic maps an array of text/author', () => {
  const json = [{ text: 'Look to nothing except to reason.', author: 'Marcus Aurelius' }, { text: 'bad' }];
  assert.deepEqual(DS.parseStoic(json), [{ text: 'Look to nothing except to reason.', author: 'Marcus Aurelius' }]);
  assert.deepEqual(DS.parseStoic({ not: 'an array' }), []);
});

test('mergePool dedupes by text (case-insensitive) and caps size, keeping newest', () => {
  const a = { text: 'Alpha thought here.', author: 'A' };
  const b = { text: 'Beta thought here.', author: 'B' };
  const aDup = { text: 'ALPHA thought here.', author: 'A2' };
  assert.deepEqual(DS.mergePool([a], [b, aDup]), [a, b]);
  const many = Array.from({ length: 10 }, (_, i) => ({ text: `Thought number ${i}.`, author: 'X' }));
  const capped = DS.mergePool(many.slice(0, 6), many.slice(6), 8);
  assert.equal(capped.length, 8);
  assert.equal(capped[capped.length - 1].text, 'Thought number 9.');
});

test('needsRefill: small or stale pool needs a refill, unless offline or tried recently', () => {
  const cfg = { ...DS.CONFIG, onlineQuotes: true };
  const H = 60 * 60 * 1000;
  const full = Array.from({ length: cfg.quotePoolMin }, (_, i) => ({ text: `Q${i} text.`, author: 'X' }));
  assert.equal(DS.needsRefill({ items: [], fetchedAt: 0, attemptAt: 0 }, NOW, cfg), true);
  assert.equal(DS.needsRefill({ items: full, fetchedAt: NOW - H, attemptAt: NOW - H }, NOW, cfg), false);
  assert.equal(DS.needsRefill({ items: full, fetchedAt: NOW - 25 * H, attemptAt: NOW - 25 * H }, NOW, cfg), true);
  assert.equal(DS.needsRefill({ items: [], fetchedAt: 0, attemptAt: NOW - 60 * 1000 }, NOW, cfg), false);
  assert.equal(DS.needsRefill({ items: [], fetchedAt: 0, attemptAt: 0 }, NOW, { ...cfg, onlineQuotes: false }), false);
  assert.equal(DS.needsRefill(undefined, NOW, cfg), true);
});
