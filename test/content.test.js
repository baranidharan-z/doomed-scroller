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
const BAR_H = 36; // normal bar height in content.js
const VH = 800; // fake window.innerHeight

class FakeStyle {
  constructor() { this.cssText = ''; }
  setProperty(k, v) { this[k] = v; }
  getPropertyValue(k) { return this[k] || ''; }
  removeProperty(k) { delete this[k]; }
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
    this._text = '';
    this.hidden = false;
    this.disabled = false;
    this.className = '';
    this.shadow = null;
  }
  // Like the real DOM: setting textContent replaces the children.
  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v); this.children = []; }
  appendChild(c) {
    if (c.parentNode) c.parentNode.children = c.parentNode.children.filter((x) => x !== c);
    this.children.push(c);
    c.parentNode = this;
    c.isConnected = this.isConnected;
    return c;
  }
  append(...cs) { cs.forEach((c) => this.appendChild(typeof c === 'string' ? Object.assign(new FakeEl('#text'), { textContent: c }) : c)); }
  addEventListener(t, f) { (this.listeners[t] ||= []).push(f); }
  click() { (this.listeners.click || []).forEach((f) => f({ target: this })); }
  setAttribute(k, v) { this[k] = v; (this.attrs ||= {})[k] = String(v); }
  hasAttribute(k) { return !!this.attrs && k in this.attrs; }
  removeAttribute(k) { if (this.attrs) delete this.attrs[k]; delete this[k]; }
  remove() {
    if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((x) => x !== this);
    this.parentNode = null;
    this.isConnected = false;
  }
  focus() {}
  attachShadow() { this.shadow = new FakeEl('#shadow'); return this.shadow; }
  set innerHTML(_v) { throw new TypeError("This document requires 'TrustedHTML' assignment."); }
}

function allText(node) {
  if (!node || node.hidden) return ''; // hidden elements aren't visible
  return [node.textContent, ...node.children.map(allText), allText(node.shadow)].join(' ');
}

function walk(node, fn) {
  if (!node) return null;
  if (fn(node)) return node;
  for (const c of node.children) {
    const hit = walk(c, fn);
    if (hit) return hit;
  }
  return walk(node.shadow, fn);
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

const byClass = (root, cls) => walk(root, (n) => String(n.className).split(' ').includes(cls));
const button = (root, re) => walk(root, (n) => n.tagName === 'button' && re.test(allText(n)));

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
    querySelector: (sel) => (opts.elements && opts.elements[sel]) || null,
    // Media elements the page has (fake <video>/<audio>), for 'video, audio'.
    querySelectorAll: (sel) => (/video|audio/.test(sel) ? opts.media || [] : []),
    elementsFromPoint: () => opts.atTop || [],
  };
  const sent = [];
  const intervals = [];
  const events = [];
  const location = { hostname: opts.hostname || 'www.youtube.com', pathname: opts.pathname || '/' };
  const ctx = {
    DS,
    location,
    document,
    window: { innerWidth: 1200, innerHeight: VH, dispatchEvent: (e) => { events.push(e.type); return true; } },
    Event: class { constructor(type) { this.type = type; } },
    Element: FakeEl,
    getComputedStyle: (e) => e.computed,
    setInterval: (f, ms) => { intervals.push({ f, ms }); return intervals.length; },
    clearInterval: () => {},
    console: { info() {}, warn() {}, error() {}, log() {} },
    chrome: {
      runtime: { id: 'test', sendMessage: async (m) => { sent.push(m); return typeof reply === 'function' ? reply(m) : reply; } },
      storage: { local: { get: async () => opts.storage || {} } },
    },
    Date: class extends Date { static now() { return clock.t; } },
  };
  vm.runInNewContext(SRC, ctx);
  // Looked up lazily: for sites added in settings the script starts async.
  const interval = (ms) => intervals.find((i) => i.ms === ms);
  const flush = () => interval(5000).f();
  const tick = () => interval(1000).f();
  const advance = (ms) => { clock.t += ms; tick(); };
  const fire = (type) => (docListeners[type] || []).forEach((f) => f({ target: document }));
  return { sent, intervals, flush, tick, advance, fire, document, documentElement, clock, events, location };
}

const settle = () => new Promise((r) => setImmediate(r));

const OK = {
  site: 'youtube',
  state: 'ok',
  rec: { activeMs: 1 * MIN, extensions: 0, blockedUntil: 0 },
  thresholds: { ms: 15 * MIN },
  maxExtensions: 3,
  extendMinutes: 5,
};
const WARN = { ...OK, state: 'warn', rec: { ...OK.rec, activeMs: 15 * MIN } };
const at = (activeMs, extra = {}) => ({ ...OK, rec: { ...OK.rec, activeMs, ...extra.rec }, ...extra.top });
const barHost = (env) => findHost(env.documentElement, 'DoomedScroller');
const barText = (env) => allText(barHost(env));
const count = (text, re) => (text.match(new RegExp(re.source, 'g')) || []).length;
const marginTop = (env) => env.documentElement.style['margin-top'];

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

// ---- extend button cool-off ----------------------------------------------------

test('extend button is locked with a countdown during the cool-off', async () => {
  const clock = { t: 10_000_000 };
  const env = makeEnv({ ...WARN, extendAt: clock.t + 2 * MIN }, { clock });
  await settle();
  const btn = button(env.documentElement, /Come back in/);
  assert.ok(btn, 'locked button shown');
  assert.equal(btn.disabled, true);
  assert.match(allText(btn), /Come back in 2:00 to extend/);
  env.advance(1000);
  assert.match(allText(btn), /Come back in 1:59 to extend/);
});

test('extend button unlocks when the cool-off ends', async () => {
  const clock = { t: 10_000_000 };
  const env = makeEnv({ ...WARN, extendAt: clock.t + 2 * MIN }, { clock });
  await settle();
  for (let i = 0; i < 120; i++) env.advance(1000);
  const btn = button(env.documentElement, /5 more minutes/);
  assert.ok(btn, 'unlocked button shown');
  assert.equal(btn.disabled, false);
});

test('clicking a locked extend button sends nothing', async () => {
  const clock = { t: 10_000_000 };
  const env = makeEnv({ ...WARN, extendAt: clock.t + 2 * MIN }, { clock });
  await settle();
  button(env.documentElement, /Come back in/).click();
  await settle();
  assert.equal(env.sent.filter((m) => m.type === 'extend').length, 0);
});

test('clicking an unlocked extend button asks the background to extend', async () => {
  const clock = { t: 10_000_000 };
  const env = makeEnv({ ...WARN, extendAt: clock.t - 1 }, { clock });
  await settle();
  button(env.documentElement, /5 more minutes/).click();
  await settle();
  assert.equal(env.sent.filter((m) => m.type === 'extend').length, 1);
});

// ---- sites added in settings --------------------------------------------------

test('a site added in settings is tracked under its domain', async () => {
  const env = makeEnv({ ...OK, site: 'instagram.com' }, { hostname: 'www.instagram.com', storage: { customSites: ['instagram.com'] } });
  await settle(); await settle();
  const ticks = env.sent.filter((m) => m.type === 'tick');
  assert.ok(ticks.length >= 1);
  assert.equal(ticks[0].site, 'instagram.com');
  assert.match(barText(env), /Total time for instagram\.com/);
});

test('a site that is neither built in nor added does nothing', async () => {
  const env = makeEnv(OK, { hostname: 'www.example.com', storage: { customSites: ['instagram.com'] } });
  await settle(); await settle();
  assert.equal(env.sent.length, 0);
  assert.equal(env.intervals.length, 0);
});

test('a site removed in code is not tracked even if still stored', async () => {
  // DS.customSites applies SITE_REMOVALS; an invalid stored entry stands in.
  const env = makeEnv(OK, { hostname: 'bad', storage: { customSites: ['bad'] } });
  await settle(); await settle();
  assert.equal(env.sent.length, 0);
});

// ---- one bar: name | time wasted | total ---------------------------------------

test('bar shows the name, time wasted today and total time for the site', async () => {
  const env = makeEnv(OK);
  await settle();
  const text = barText(env);
  assert.match(text, /DoomedScroller/);
  assert.match(text, /Time wasted today/);
  assert.match(text, /\b1:00\b/);
  assert.match(text, /Total time for youtube/);
  assert.match(text, /\b15:00\b/);
  assert.doesNotMatch(text, /time left/i);
});

test('there is one bar only: time wasted appears once, small or grown', async () => {
  for (const ms of [1 * MIN, 13 * MIN]) {
    const env = makeEnv(at(ms));
    await settle();
    assert.equal(count(allText(env.documentElement), /Time wasted today/), 1, `at ${ms / MIN} min`);
  }
});

test('total time includes extensions', async () => {
  const env = makeEnv({ ...OK, rec: { ...OK.rec, extensions: 1 }, thresholds: { ms: 20 * MIN } });
  await settle();
  assert.match(barText(env), /\b20:00\b/);
});

test('bar ticks every second without waiting for a flush', async () => {
  const env = makeEnv(OK);
  await settle();
  env.advance(1000);
  assert.match(barText(env), /\b1:01\b/);
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
  assert.match(barText(env), /\b1:05\b/, 'in flight');
  release();
  await flushing; await settle();
  assert.match(barText(env), /\b1:05\b/, 'after reply');
});

test('bar shows paused when idle', async () => {
  const env = makeEnv(OK);
  await settle();
  env.advance(DS.CONFIG.idleMs + 1000);
  assert.match(barText(env), /paused/i);
});

test('bar spans the full width at the very top and pushes the page down', async () => {
  const env = makeEnv(OK);
  await settle();
  const bar = barHost(env);
  assert.ok(bar, 'bar host exists');
  assert.match(bar.style.cssText, /top:\s*0/);
  assert.match(bar.style.cssText, /left:\s*0/);
  assert.match(bar.style.cssText, /right:\s*0/);
  assert.match(bar.style.cssText, new RegExp(String.raw`height:\s*${BAR_H}px`));
  assert.equal(marginTop(env), `${BAR_H}px`);
});

test('html becomes the containing block so absolute app shells move down too', async () => {
  // YouTube's ytd-app is position:absolute; top:0 with no positioned ancestor,
  // which ignores the html margin unless html itself is positioned.
  const env = makeEnv(OK);
  await settle();
  assert.equal(env.documentElement.style.position, 'relative');
});

// ---- gradual growth from 75% to 35% of window height ---------------------------

test('bar is normal height below 75%', async () => {
  const env = makeEnv(at(11 * MIN)); // 73%
  await settle();
  assert.equal(marginTop(env), `${BAR_H}px`);
});

test('bar grows gradually past 75%', async () => {
  const a = makeEnv(at(12 * MIN)); // 80% -> 7% of 800 = 56px
  const b = makeEnv(at(13 * MIN)); // 86.7% -> ~16.3% -> 132px (4px steps)
  await settle();
  assert.equal(marginTop(a), '56px');
  assert.equal(marginTop(b), '132px');
});

test('bar reaches 35% of window height at the limit', async () => {
  const env = makeEnv(at(15 * MIN));
  await settle();
  assert.equal(marginTop(env), `${0.35 * VH}px`);
});

test('bar stays at 35% after an extension', async () => {
  const env = makeEnv(at(15 * MIN, { rec: { extensions: 1 }, top: { thresholds: { ms: 20 * MIN } } }));
  await settle();
  assert.equal(marginTop(env), `${0.35 * VH}px`);
});

test('bar colour stage: none, calm, caution, stop', async () => {
  const cases = [[11 * MIN, null], [12 * MIN, 'calm'], [13.5 * MIN, 'caution'], [14.5 * MIN, 'stop']];
  for (const [ms, stage] of cases) {
    const env = makeEnv(at(ms));
    await settle();
    const bar = byClass(barHost(env).shadow, 'bar');
    for (const s of ['calm', 'caution', 'stop']) {
      assert.equal(String(bar.className).split(' ').includes(s), s === stage, `${ms / MIN} min: ${s}`);
    }
  }
});

test('time wasted gets bigger as the bar grows', async () => {
  const sizeAt = async (ms) => {
    const env = makeEnv(at(ms));
    await settle();
    return parseFloat(byClass(barHost(env).shadow, 'used').style.fontSize);
  };
  const small = await sizeAt(1 * MIN);
  const mid = await sizeAt(13 * MIN);
  const big = await sizeAt(15 * MIN);
  assert.ok(mid > small, `${mid} > ${small}`);
  assert.ok(big > mid, `${big} > ${mid}`);
});

test('pinned headers follow the bar as it grows', async () => {
  const header = new FakeEl('ytd-masthead');
  header.computed = { position: 'fixed', top: '0px' };
  let r = at(11 * MIN);
  const env = makeEnv(() => r, { atTop: [header] });
  env.documentElement.appendChild(header); // attached, like a real header
  await settle();
  env.advance(1000);
  assert.equal(header.style.top, `${BAR_H}px`);
  r = at(13 * MIN);
  await env.flush(); await settle();
  assert.equal(header.style.top, '132px');
});

// ---- pinned elements ------------------------------------------------------------

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

// ---- fullscreen ---------------------------------------------------------------------

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

// youtube.com fullscreens <html> itself, so the bar's margin stays and the
// 100vh-tall player would be cut at the bottom. The player area is shrunk to
// (100vh - bar) and a resize event makes the player re-fit the video.
function fsEnv(reply) {
  const container = new FakeEl('div');
  const env = makeEnv(reply, { elements: { '#full-bleed-container': container } });
  return { env, container };
}
const enterRootFullscreen = (env) => { env.document.fullscreenElement = env.documentElement; env.fire('fullscreenchange'); };
const exitFullscreen = (env) => { env.document.fullscreenElement = null; env.fire('fullscreenchange'); };

test('fullscreen of the whole page shrinks the video area to fit below the bar', async () => {
  const { env, container } = fsEnv(OK);
  await settle();
  enterRootFullscreen(env);
  assert.equal(container.style.height, `calc(100vh - ${BAR_H}px)`);
  assert.equal(container.style['max-height'], 'none');
  assert.equal(env.events.filter((e) => e === 'resize').length, 1, 'player told to re-fit');
});

test('in fullscreen the video area keeps shrinking as the bar grows', async () => {
  let r = at(11 * MIN);
  const { env, container } = fsEnv(() => r);
  await settle();
  enterRootFullscreen(env);
  assert.equal(container.style.height, `calc(100vh - ${BAR_H}px)`);
  r = at(13 * MIN);
  await env.flush(); await settle();
  assert.equal(container.style.height, 'calc(100vh - 132px)');
});

test('no repeated resize events while nothing changes', async () => {
  const { env } = fsEnv(OK);
  await settle();
  enterRootFullscreen(env);
  env.advance(1000); env.advance(1000); env.advance(1000);
  assert.equal(env.events.filter((e) => e === 'resize').length, 1);
});

test('leaving fullscreen restores the video area', async () => {
  const { env, container } = fsEnv(OK);
  await settle();
  enterRootFullscreen(env);
  exitFullscreen(env);
  assert.equal(container.style.height, undefined);
  assert.equal(container.style['max-height'], undefined);
  assert.equal(env.events.filter((e) => e === 'resize').length, 2, 'player told to re-fit again');
});

test('fullscreen of a single element (not the page) leaves the video area alone', async () => {
  const { env, container } = fsEnv(OK);
  await settle();
  const player = new FakeEl('div');
  env.documentElement.appendChild(player);
  env.document.fullscreenElement = player;
  env.fire('fullscreenchange');
  assert.equal(container.style.height, undefined);
});

// ---- YouTube subscriptions: one big video per row ------------------------------
// The grid's column count comes from --ytd-rich-grid-items-per-row, which
// YouTube's own script also sets inline, so the override needs !important.

const SUBS = '/feed/subscriptions';
const subsStyle = (env) => walk(env.documentElement, (n) => n.tagName === 'style' && /items-per-row/.test(n.textContent));
const subsOn = (env) => env.documentElement.hasAttribute('data-doomed-subs');

test('subscriptions page gets one video per row', async () => {
  const env = makeEnv(OK, { pathname: SUBS });
  await settle();
  assert.equal(subsOn(env), true);
  const style = subsStyle(env);
  assert.ok(style, 'layout style injected');
  assert.match(style.textContent, /--ytd-rich-grid-items-per-row:\s*1\s*!important/);
});

test('the single video is allowed to be big (lifts the 500px item cap)', async () => {
  const env = makeEnv(OK, { pathname: SUBS });
  await settle();
  assert.match(subsStyle(env).textContent, /--ytd-rich-grid-item-max-width:[^;]*!important/);
});

test('layout rules only apply while the page is marked as subscriptions', async () => {
  const env = makeEnv(OK, { pathname: SUBS });
  await settle();
  const rules = subsStyle(env).textContent.split('}').filter((r) => r.includes('{'));
  for (const r of rules) assert.match(r, /html\[data-doomed-subs\]/, r.trim());
});

test('other YouTube pages keep the normal grid', async () => {
  for (const pathname of ['/', '/watch', '/feed/history', '/results']) {
    const env = makeEnv(OK, { pathname });
    await settle();
    assert.equal(subsOn(env), false, pathname);
  }
});

test('navigating to and away from subscriptions toggles the layout', async () => {
  const env = makeEnv(OK, { pathname: '/' });
  await settle();
  assert.equal(subsOn(env), false);
  env.location.pathname = SUBS; // YouTube changes pages without reloading
  env.advance(1000);
  assert.equal(subsOn(env), true);
  env.location.pathname = '/watch';
  env.fire('yt-navigate-finish');
  assert.equal(subsOn(env), false);
});

test('other sites never get the YouTube layout', async () => {
  const env = makeEnv({ ...OK, site: 'reddit' }, { hostname: 'www.reddit.com', pathname: SUBS });
  await settle();
  assert.equal(subsOn(env), false);
  assert.equal(subsStyle(env), null);
});

// ---- watching counts: playing media is activity ------------------------------
// Bug: watching a video (fullscreen or not) without touching anything paused
// the timer after idleMs, and pressing Alt (focus moves to the browser's menu
// on Windows) paused it too. Playing media on a visible tab now counts.

const video = (playing) => ({ paused: !playing, ended: false, readyState: 4, pause() { this.paused = true; } });
const sentMs = (env) => env.sent.filter((m) => m.type === 'tick').reduce((a, m) => a + m.activeMs, 0);

test('a playing video keeps the timer running with no input past the idle limit', async () => {
  const env = makeEnv(OK, { media: [video(true)] });
  await settle();
  const secs = DS.CONFIG.idleMs / 1000 + 30; // 90s of hands-off watching
  for (let i = 0; i < secs; i++) env.advance(1000);
  assert.doesNotMatch(barText(env), /paused/i);
  await env.flush(); await settle();
  assert.equal(sentMs(env), secs * 1000);
});

test('a playing video keeps counting when the page loses focus (e.g. Alt key)', async () => {
  const env = makeEnv(OK, { media: [video(true)] });
  await settle();
  env.document.hasFocus = () => false;
  env.advance(1000);
  env.advance(1000);
  assert.doesNotMatch(barText(env), /paused/i);
  await env.flush(); await settle();
  assert.equal(sentMs(env), 2000);
});

test('a paused video does not count once idle', async () => {
  const env = makeEnv(OK, { media: [video(false)] });
  await settle();
  env.advance(DS.CONFIG.idleMs + 1000);
  assert.match(barText(env), /paused/i);
});

test('browsing without media still pauses when the page loses focus', async () => {
  const env = makeEnv(OK);
  await settle();
  env.document.hasFocus = () => false;
  env.advance(1000);
  assert.match(barText(env), /paused/i);
});

test('a hidden tab never counts, even with a video playing', async () => {
  const env = makeEnv(OK, { media: [video(true)] });
  await settle();
  env.document.visibilityState = 'hidden';
  env.advance(1000);
  await env.flush(); await settle();
  assert.equal(sentMs(env), 0);
});

test('a video that has ended or has no data yet does not count as playing', async () => {
  const env = makeEnv(OK, { media: [{ paused: false, ended: true, readyState: 4, pause() {} }, { paused: false, ended: false, readyState: 1, pause() {} }] });
  await settle();
  env.advance(DS.CONFIG.idleMs + 1000);
  assert.match(barText(env), /paused/i);
});
