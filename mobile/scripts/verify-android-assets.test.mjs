import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyAssets } from './verify-android-assets.mjs';

test('rejects USB assets in release, including a forged release marker', () => {
  const root = mkdtempSync(join(tmpdir(), 'lueftlotse-assets-'));
  writeFileSync(join(root, 'build-profile.json'), JSON.stringify({ profile: 'usb-debug' }));
  writeFileSync(join(root, 'main.js'), 'http://127.0.0.1:5045/api');
  assert.throws(() => verifyAssets(root, 'release'));
  verifyAssets(root, 'usb-debug');
  writeFileSync(join(root, 'build-profile.json'), JSON.stringify({ profile: 'release' }));
  assert.throws(() => verifyAssets(root, 'release'));
  writeFileSync(join(root, 'main.js'), 'nativeBaseUrl:null');
  verifyAssets(root, 'release');
  assert.throws(() => verifyAssets(root, 'usb-debug'));
});
