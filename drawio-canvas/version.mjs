import { readFileSync } from 'node:fs';

// Read at bridge startup so release bumps do not require rebundling the runtime.
export function readReleaseVersion(filename = new URL('./version.txt', import.meta.url)) {
  const version = readFileSync(filename, 'utf8').trim();
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    throw new Error('Invalid extension release version');
  }
  return version;
}
