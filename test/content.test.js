'use strict';
// Loads content.js into a VM with a minimal fake DOM. The fake rejects
// innerHTML the way YouTube's Trusted Types policy does, so the UI must be
// built with DOM APIs, and a render failure must not corrupt counting.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const DS = require('../shared.js');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');
const MIN = 60 * 1000;

class FakeStyle {
  constructor() { this.cssText = ''; }
  setProperty(k, v) { this[k] = v; }
  getPropertyValue(k) { return this[k] || ''; }
}

class FakeEl {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.style = new FakeStyle();
    this.computed = { position: 'static', top: 'auto' };
    this.listeners = {};
    this.isConnected = false;
    this.parentNode = null;
    this.textContent = '';
    this.hidden = false;
    this.shadow = null;
    this.rect = { left: 0, top: 0, bottom: 0, width: 0, height: 0 };
  }
  appendChild(c) {
    if (c.parentNode) c.parentNode.children = c.parentNode.children.filter((x) => x !== c);
    this.children.push(c);
    c.parentNode = this;
    c.isConnected = this.isConnected;
    return c;
  }
  append(...cs) { cs.forEach((c) => this.appendChild(typeof c === 'string' ? Object.assign(new FakeEl('#text'), { textContent: c }) : c)); }
  addEventListener(t, f) { (this.listeners[t] ||= []).push(f); }
  setAttribute(k, v) { this[k] = v; }
  remove() {
    if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((x) => x !== this);
    this.parentNode = null;
    this.isConnected = false;
  }
  focus() {}
  getBoundingClientRect() { return this.rect; }
  attachShadow() { this.shadow = new FakeEl('#shadow'); return this.shadow; }
  set innerHTML(_v) { throw new TypeError("This document requires 'TrustedHTML' assignment."); }
}

function allText(node) {
  if (!node || node.hidden) return ''; // hidden elements aren't visible
  return [node.textContent, ...node.children.map(allText), allText(node.shadow)].join(' ');
}

// The host element whose shadow DOM contains `needle`.
function findHost(root, needle) {
  for (const c of root.children) {
    if (c.shadow && allText(c.shadow).includes(needle)) return c;
    const deeper = findHost(c, needle);
    if (deeper) return deeper;
  }
  return null;
}

// reply: a response object, or a function(msg) returning one / a promise.
function makeEnv(reply, opts = {}) {
  const clock = opts.clock || { t: 1_000_000 };
  const docListeners = {};
  const documentElement = new FakeEl('html');
  documentElement.isConnected = true;
  const document = {
    documentElement,
    body: new FakeEl('body'),
    fullscreenElement: null,
    visibilityState: 'visible',
    hasFocus: () => true,
    addEventListener: (t, f) => { (docListeners[t] ||= []).push(f); },
    createElement: (t) => new FakeEl(t),
    querySelector: () => null,
    querySelectorAll: () => [],
    elementsFromPoint: () => opts.atTop || [],
  };
  const sent = [];
  const intervals = [];
  const ctx = {
    DS,
    location: { hostname: 'www.youtube.com' },
    document,
    window: { innerWidth: 1200, innerHeight: 800 },
    Element: FakeEl,
    getComputedStyle: (e) => e.computed,
    setInterval: (f, ms) => { intervals.push({ f, ms }); return intervals.length; },
    clearInterval: () => {},
    console: { info() {}, warn() {}, error() {}, log() {} },
    chrome: { runtime: { id: 'test', sendMessage: async (m) => {
      sent.push(m);
      if (m.type === 'getQuote') return typeof opts.quote === 'function' ? opts.quote(m) : { quote: opts.quote || null };
      return typeof reply === 'function' ? reply(m) : reply;
    } } },
    Date: class extends Date { static now() { return clock.t; } },
  };
  vm.runInNewContext(SRC, ctx);
  const flush = intervals.find((i) => i.ms === 5000).f;
  const tick = intervals.find((i) => i.ms === 1000).f;
  const advance = (ms) => { clock.t += ms; tick(); };
  const fire = (type) => (docListeners[type] || []).forEach((f) => f({ target: document }));
  return { sent, flush, tick, advance, fire, document, documentElement, clock };
}

const settle = () => new Promise((r) => setImmediate(r));

const OK = {
  site: 'youtube',
  state: 'ok',
  rec: { activeMs: 1 * MIN, extensions: 0, blockedUntil: 0 },
  thresholds: { ms: 15 * MIN },
  maxExtensions: 3,
};
const WARN = { ...OK, state: 'warn', rec: { ...OK.rec, activeMs: 15 * MIN } };

// ---- overlay and counting --------------------------------------------------

test('warn overlay renders when innerHTML is forbidden (Trusted Types)', async () => {
  const env = makeEnv(WARN);
  await settle();
  const text = allText(env.documentElement);
  assert.match(text, /doomscrolling/);
  assert.match(text, /5 more minutes/);
});

test('time already acknowledged is not resent when rendering fails', async () => {
  // A reply without thresholds makes rendering throw after the send succeeded.
  const BROKEN = { site: 'youtube', state: 'ok', rec: { activeMs: 0, extensions: 0, blockedUntil: 0 } };
  const env = makeEnv(BROKEN);
  await settle();
  env.advance(1000);
  await env.flush(); await settle();
  await env.flush(); await settle();
  const times = env.sent.filter((m) => m.type === 'tick').map((m) => m.activeMs);
  assert.deepEqual(times, [0, 1000, 0]);
});

test('scroll counts as activity but no scroll distance is sent', async () => {
  const env = makeEnv(OK);
  await settle();
  const steps = DS.CONFIG.idleMs / 1000 - 1;
  for (let i = 0; i < steps; i++) env.advance(1000);
  env.fire('scroll'); // resets the idle timer just before it would expire
  env.advance(1000);
  env.advance(1000); // would be idle by now without the scroll
  await env.flush(); await settle();
  const last = env.sent[env.sent.length - 1];
  assert.equal(last.activeMs, DS.CONFIG.idleMs + 1000);
  assert.equal('screens' in last, false);
});

// ---- live timer bar ----------------------------------------------------------

const BAR_H = 36;

test('bar shows the name, time wasted today and total time for the site', async () => {
  const env = makeEnv(OK);
  await settle();
  const text = allText(env.documentElement);
  assert.match(text, /DoomedScroller/);
  assert.match(text, /Time wasted today/);
  assert.match(text, /\b1:00\b/);
  assert.match(text, /Total time for youtube/);
  assert.match(text, /\b15:00\b/);
  assert.doesNotMatch(text, /left to waste/i);
});

test('total time includes extensions', async () => {
  const env = makeEnv({ ...OK, rec: { ...OK.rec, extensions: 1 }, thresholds: { ms: 20 * MIN } });
  await settle();
  assert.match(allText(env.documentElement), /\b20:00\b/);
});

test('bar ticks every second without waiting for a flush', async () => {
  const env = makeEnv(OK);
  await settle();
  env.advance(1000);
  assert.match(allText(env.documentElement), /\b1:01\b/);
});

test('bar does not dip while a flush is in flight', async () => {
  let release;
  let first = true;
  const env = makeEnv((m) => {
    if (first) { first = false; return OK; }
    // Hold the second reply until we release it.
    return new Promise((r) => { release = () => r({ ...OK, rec: { ...OK.rec, activeMs: OK.rec.activeMs + m.activeMs } }); });
  });
  await settle();
  for (let i = 0; i < 5; i++) env.advance(1000);
  const flushing = env.flush();
  await settle();
  assert.match(allText(env.documentElement), /\b1:05\b/, 'in flight');
  release();
  await flushing; await settle();
  assert.match(allText(env.documentElement), /\b1:05\b/, 'after reply');
});

test('bar shows paused when idle', async () => {
  const env = makeEnv(OK);
  await settle();
  env.advance(DS.CONFIG.idleMs + 1000);
  assert.match(allText(env.documentElement), /paused/i);
});

test('bar spans the full width at the very top and pushes the page down', async () => {
  const env = makeEnv(OK);
  await settle();
  const bar = findHost(env.documentElement, 'DoomedScroller');
  assert.ok(bar, 'bar host exists');
  assert.match(bar.style.cssText, /top:\s*0/);
  assert.match(bar.style.cssText, /left:\s*0/);
  assert.match(bar.style.cssText, /right:\s*0/);
  assert.match(bar.style.cssText, new RegExp(String.raw`height:\s*${BAR_H}px`));
  assert.equal(env.documentElement.style['margin-top'], `${BAR_H}px`);
});

test('a site header pinned to the top is moved below the bar', async () => {
  const header = new FakeEl('ytd-masthead');
  header.computed = { position: 'fixed', top: '0px' };
  const env = makeEnv(OK, { atTop: [header] });
  await settle();
  env.advance(1000);
  assert.equal(header.style.top, `${BAR_H}px`);
});

test('a pinned element lower down keeps its offset, plus the bar height', async () => {
  const guide = new FakeEl('ytd-mini-guide-renderer');
  guide.computed = { position: 'fixed', top: '56px' };
  const env = makeEnv(OK, { atTop: [guide] });
  await settle();
  env.advance(1000);
  assert.equal(guide.style.top, `${56 + BAR_H}px`);
});

test('a header already moved is not moved again on later ticks', async () => {
  const header = new FakeEl('div');
  header.computed = { position: 'sticky', top: '0px' };
  const env = makeEnv(OK, { atTop: [header] });
  await settle();
  env.advance(1000);
  env.advance(1000);
  env.advance(1000);
  assert.equal(header.style.top, `${BAR_H}px`);
});

test('a header whose style the site reset is moved again', async () => {
  const header = new FakeEl('div');
  header.computed = { position: 'fixed', top: '0px' };
  const env = makeEnv(OK, { atTop: [header] });
  await settle();
  env.advance(1000);
  header.style.top = ''; // site re-rendered and wiped our inline style
  env.advance(1000);
  assert.equal(header.style.top, `${BAR_H}px`);
});

test('normal (non-pinned) elements are left alone', async () => {
  const div = new FakeEl('div');
  const env = makeEnv(OK, { atTop: [div] });
  await settle();
  env.advance(1000);
  assert.equal(div.style.top, undefined);
});

test('bar moves into the fullscreen element and back', async () => {
  const env = makeEnv(OK);
  await settle();
  const player = new FakeEl('div');
  env.documentElement.appendChild(player);
  env.document.fullscreenElement = player;
  env.fire('fullscreenchange');
  assert.ok(findHost(player, 'DoomedScroller'), 'inside fullscreen element');

  env.document.fullscreenElement = null;
  env.fire('fullscreenchange');
  assert.equal(findHost(player, 'DoomedScroller'), null);
  assert.ok(findHost(env.documentElement, 'DoomedScroller'), 'back on the page');
});

test('warn overlay also shows inside the fullscreen element', async () => {
  const player = new FakeEl('div');
  const env = makeEnv(WARN);
  env.documentElement.appendChild(player);
  env.document.fullscreenElement = player;
  env.fire('fullscreenchange');
  await env.flush(); await settle();
  assert.ok(findHost(player, 'doomscrolling'), 'overlay inside fullscreen element');
});

// ---- bar growth near the limit ---------------------------------------------

const VH = 800; // fake window.innerHeight
const at = (activeMs, extra = {}) => ({ ...OK, rec: { ...OK.rec, activeMs, ...extra.rec }, ...extra.top });

test('bar is normal height below 80%', async () => {
  const env = makeEnv(at(11 * MIN));
  await settle();
  const bar = findHost(env.documentElement, 'DoomedScroller');
  assert.match(bar.style.cssText, new RegExp(String.raw`height:\s*${BAR_H}px`));
  assert.equal(env.documentElement.style['margin-top'], `${BAR_H}px`);
});

test('bar grows to 10% of window height at 80% and pushes the page further down', async () => {
  const env = makeEnv(at(12 * MIN)); // 12 of 15 min = 80%
  await settle();
  const bar = findHost(env.documentElement, 'DoomedScroller');
  assert.match(bar.style.cssText, new RegExp(String.raw`height:\s*${0.10 * VH}px`));
  assert.equal(env.documentElement.style['margin-top'], `${0.10 * VH}px`);
});

test('bar is 25% of window height at 95%', async () => {
  const env = makeEnv(at(14.25 * MIN));
  await settle();
  assert.equal(env.documentElement.style['margin-top'], `${0.25 * VH}px`);
});

test('bar stays at 25% after an extension', async () => {
  const env = makeEnv(at(15 * MIN, { rec: { extensions: 1 }, top: { thresholds: { ms: 20 * MIN } } }));
  await settle();
  assert.equal(env.documentElement.style['margin-top'], `${0.25 * VH}px`);
});

test('bar grows live as time ticks past 80%, and pinned headers follow it', async () => {
  const header = new FakeEl('ytd-masthead');
  header.computed = { position: 'fixed', top: '0px' };
  const env = makeEnv(at(12 * MIN - 2000), { atTop: [header] });
  env.documentElement.appendChild(header); // attached, like a real header
  await settle();
  env.advance(1000); // 79.99%: normal
  assert.equal(header.style.top, `${BAR_H}px`);
  env.advance(1000); // 80%: grows
  assert.equal(env.documentElement.style['margin-top'], `${0.10 * VH}px`);
  assert.equal(header.style.top, `${0.10 * VH}px`);
});

// ---- philosophy quotes in the grown bar ----------------------------------

const QUOTE = { text: 'The test of a first-rate mind is patience.', author: 'Test Philosopher' };
const quoteRequests = (env) => env.sent.filter((m) => m.type === 'getQuote').length;
const barText = (env) => allText(findHost(env.documentElement, 'DoomedScroller'));

test('normal-size bar shows no quote and does not fetch one', async () => {
  const env = makeEnv(at(11 * MIN), { quote: QUOTE });
  await settle(); await settle();
  assert.doesNotMatch(barText(env), /Test Philosopher/);
  assert.equal(quoteRequests(env), 0);
});

test('grown bar shows the quote and author from the background', async () => {
  const env = makeEnv(at(12 * MIN), { quote: QUOTE });
  await settle(); await settle();
  const text = barText(env);
  assert.match(text, /The test of a first-rate mind is patience\./);
  assert.match(text, /Test Philosopher/);
});

test('grown bar shows a built-in quote while the background has not answered', async () => {
  const env = makeEnv(at(12 * MIN), { quote: () => new Promise(() => {}) });
  await settle();
  const text = barText(env);
  assert.ok(DS.FALLBACK_QUOTES.some((q) => text.includes(q.text)), 'a built-in quote is shown');
});

test('grown bar falls back to a built-in quote when the background has none', async () => {
  const env = makeEnv(at(12 * MIN), { quote: null });
  await settle(); await settle();
  const text = barText(env);
  assert.ok(DS.FALLBACK_QUOTES.some((q) => text.includes(q.text)), 'a built-in quote is shown');
});

test('quote is fetched once per rotation window, not every tick', async () => {
  const R = DS.CONFIG.quoteRotateMs;
  const clock = { t: Math.floor(5_000_000_000 / R) * R }; // start of a window
  const env = makeEnv(at(12 * MIN), { quote: QUOTE, clock });
  await settle(); await settle();
  for (let i = 0; i < 10; i++) { env.advance(1000); await settle(); }
  assert.equal(quoteRequests(env), 1);
  clock.t += R; // next window
  env.advance(0); await settle();
  assert.equal(quoteRequests(env), 2);
});

test('quote disappears again if the bar returns to normal', async () => {
  let r = at(12 * MIN);
  const env = makeEnv(() => r, { quote: QUOTE });
  await settle(); await settle();
  assert.match(barText(env), /Test Philosopher/);
  r = at(1 * MIN); // e.g. new day
  await env.flush(); await settle();
  assert.doesNotMatch(barText(env), /Test Philosopher/);
});

test('motivation lines and actions are gone', async () => {
  const env = makeEnv(at(14.25 * MIN), { quote: QUOTE });
  await settle(); await settle();
  assert.doesNotMatch(barText(env), /Ippo idha pannu|Try this/);
});

// ---- page push-down: absolutely positioned app shells ------------------------

test('html becomes the containing block so absolute app shells move down too', async () => {
  // YouTube's ytd-app is position:absolute; top:0 with no positioned ancestor,
  // which ignores the html margin unless html itself is positioned.
  const env = makeEnv(OK);
  await settle();
  assert.equal(env.documentElement.style.position, 'relative');
  assert.equal(env.documentElement.style['margin-top'], `${BAR_H}px`);
});
