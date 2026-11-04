import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export function verifyAssets(root, expected) {
  const profile = JSON.parse(readFileSync(join(root, 'build-profile.json'), 'utf8')).profile;
  if (profile !== expected) throw Error(`Wrong web profile: ${root}`);
  const files = readdirSync(root, { recursive: true }).filter(file => /\.(js|json|html)$/.test(file));
  const hasUsbAddress = files.some(file => readFileSync(join(root, file), 'utf8').includes('http://127.0.0.1:5045/api'));
  if (hasUsbAddress !== (expected === 'usb-debug')) throw Error(`Unexpected USB address in ${root}`);
  console.log(`Verified ${expected} assets: ${root}`);
}
