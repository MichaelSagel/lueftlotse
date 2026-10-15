import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { verifyAssets } from './verify-android-assets.mjs';

process.chdir(fileURLToPath(new URL('..', import.meta.url)));
const mode = process.argv[2];
if (!['release', 'usb-debug'].includes(mode)) throw Error('Expected release or usb-debug');
const run = (file, args) => execFileSync(process.execPath, [file, ...args], { stdio: 'inherit' });
const ng = 'node_modules/@angular/cli/bin/ng.js';
run(ng, ['build', '--configuration', 'production']);
writeFileSync('dist/mobile/browser/build-profile.json', JSON.stringify({ profile: 'release' }));
verifyAssets('dist/mobile/browser', 'release');
run('node_modules/@capacitor/cli/bin/capacitor', ['sync', 'android']);
verifyAssets('android/app/src/main/assets/public', 'release');
if (mode === 'usb-debug') {
  run(ng, ['build', '--configuration', 'usb-debug']);
  writeFileSync('dist/usb-debug/browser/build-profile.json', JSON.stringify({ profile: 'usb-debug' }));
  // Android's debug source set overlays main; release never includes this directory.
  mkdirSync('android/app/src/debug/assets/public', { recursive: true });
  cpSync('dist/usb-debug/browser', 'android/app/src/debug/assets/public', { recursive: true });
  verifyAssets('android/app/src/debug/assets/public', 'usb-debug');
}
