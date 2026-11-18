'use strict';
// Browsers refuse to load an extension whose files aren't valid UTF-8, and
// Node silently replaces bad bytes with U+FFFD, so other tests can't see it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const EXTS = new Set(['.js', '.json', '.html', '.css', '.md']);

function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    if (d.name === '.git' || d.name === 'node_modules') return [];
    const p = path.join(dir, d.name);
    return d.isDirectory() ? files(p) : EXTS.has(path.extname(d.name)) ? [p] : [];
  });
}

test('every source file is valid UTF-8 (no BOM, no CRLF)', () => {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const bad = [];
  for (const f of files(ROOT)) {
    const buf = fs.readFileSync(f);
    const rel = path.relative(ROOT, f);
    try {
      decoder.decode(buf);
    } catch {
      bad.push(`${rel}: not UTF-8`);
      continue;
    }
    if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) bad.push(`${rel}: has BOM`);
    if (buf.includes(0x0d)) bad.push(`${rel}: has CR`);
  }
  assert.deepEqual(bad, []);
});
