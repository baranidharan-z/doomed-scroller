'use strict';
// Loads content.js into a VM with a minimal fake DOM. The fake rejects
// innerHTML the way YouTube's Trusted Types policy does, so the overlay must
// be built with DOM APIs, and a render failure must not corrupt counting.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const DS = require('../shared.js');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');

class FakeEl {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.style = { cssText: '' };
    this.listeners = {};
    this.isConnected = false;
    this.textContent = '';
    this.hidden = false;
    this.scrollTop = 0;
    this.shadow = null;
  }
  appendChild(c) { this.children.push(c); if (this.isConnected) c.isConnected = true; return c; }
  append(...cs) { cs.forEach((c) => this.appendChild(typeof c === 'string' ? Object.assign(new FakeEl('#text'), { textContent: c }) : c)); }
  addEventListener(t, f) { (this.listeners[t] ||= []).push(f); }
  setAttribute(k, v) { this[k] = v; }
  remove() { this.isConnected = false; }
  focus() {}
  attachShadow() { this.shadow = new FakeEl('#shadow'); return this.shadow; }
  set innerHTML(_v) { throw new TypeError("This document requires 'TrustedHTML' assignment."); }
}

function allText(node) {
  if (!node) return '';
  return [node.textContent, ...node.children.map(allText), allText(node.shadow)].join(' ');
}

function makeEnv(reply) {
  const docListeners = {};
  const documentElement = new FakeEl('html');
  documentElement.isConnected = true;
  const scrollingElement = new FakeEl('html-scroll');
  const document = {
    documentElement,
    body: new FakeEl('body'),
    scrollingElement,
    visibilityState: 'visible',
    hasFocus: () => true,
    addEventListener: (t, f) => { (docListeners[t] ||= []).push(f); },
    createElement: (t) => new FakeEl(t),
    querySelectorAll: () => [],
  };
  const sent = [];
  const intervals = [];
  const ctx = {
    DS,
    location: { hostname: 'www.youtube.com' },
    document,
    window: { innerHeight: 800 },
    Element: FakeEl,
    setInterval: (f, ms) => { intervals.push({ f, ms }); return intervals.length; },
    clearInterval: () => {},
    console: { info() {}, warn() {}, error() {}, log() {} },
    chrome: { runtime: { id: 'test', sendMessage: async (m) => { sent.push(m); return reply; } } },
  };
  vm.runInNewContext(SRC, ctx);
  const flush = intervals.find((i) => i.ms === 5000).f;
  const scrollTo = (top) => {
    scrollingElement.scrollTop = top;
    (docListeners.scroll || []).forEach((f) => f({ target: document }));
  };
  return { sent, flush, scrollTo, documentElement };
}

const settle = () => new Promise((r) => setImmediate(r));

const WARN = {
  site: 'youtube',
  state: 'warn',
  rec: { activeMs: 60000, screens: 10, extensions: 0, blockedUntil: 0 },
  thresholds: { ms: 60000, screens: 5 },
  maxExtensions: 3,
};

test('warn overlay renders when innerHTML is forbidden (Trusted Types)', async () => {
  const env = makeEnv(WARN);
  await settle(); // initial flush on load
  const text = allText(env.documentElement);
  assert.match(text, /doomscrolling/);
  assert.match(text, /5 more minutes/);
});

test('deltas already acknowledged by background are never resent', async () => {
  const env = makeEnv(WARN);
  await settle();
  env.scrollTo(0);
  env.scrollTo(800); // exactly 1 screen
  await env.flush(); await settle();
  await env.flush(); await settle();
  const screens = env.sent.filter((m) => m.type === 'tick').map((m) => m.screens);
  assert.deepEqual(screens, [0, 1, 0]);
});
