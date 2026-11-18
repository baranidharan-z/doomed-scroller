'use strict';
// The README promises nothing leaves the device and that site access is only
// granted for sites you add yourself. Keep the manifest honest.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));

test('no host access is granted up front', () => {
  assert.equal(manifest.host_permissions, undefined);
});

test('permissions: storage, plus scripting to track sites added in settings', () => {
  assert.deepEqual(manifest.permissions, ['storage', 'scripting']);
});

test('site access for added sites is optional, requested one site at a time', () => {
  assert.deepEqual(manifest.optional_host_permissions, ['*://*/*']);
});

test('icons are declared and the files exist as PNGs', () => {
  for (const size of ['16', '32', '48', '128']) {
    const rel = manifest.icons && manifest.icons[size];
    assert.ok(rel, `icon ${size} declared`);
    assert.equal(manifest.action.default_icon[size], rel, `toolbar icon ${size}`);
    const buf = fs.readFileSync(path.join(ROOT, rel));
    assert.deepEqual([...buf.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], `${rel} is a PNG`);
  }
});
