import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { buildRuntime } from './build';

test('source-distributed Node bundle and build metadata exactly match current pinned inputs', async () => {
  const built = await buildRuntime();
  expect(readFileSync(new URL('./runtime.mjs', import.meta.url), 'utf8')).toBe(built.text);
  expect(JSON.parse(readFileSync(new URL('./build-manifest.json', import.meta.url), 'utf8'))).toEqual(built.metadata);
  expect(built.text).not.toMatch(/\bBun\.|\/Users\/|\/home\/|[A-Z]:\\Users\\/);
  expect(built.text).not.toMatch(/(?:from|import\()\s*['"]@xmldom\/xmldom/);
  expect(built.metadata.dependency).toBe('@xmldom/xmldom@0.9.12');
  expect(built.text).toContain('THIRD_PARTY_NOTICES.txt');
});

test('ordinary Node imports the production runtime without starting a server or requiring Bun', () => {
  const result = execFileSync('node', ['--input-type=module', '-e', `
    const runtime = await import('./drawio-canvas/runtime.mjs');
    if (typeof globalThis.Bun !== 'undefined') throw new Error('Not ordinary Node');
    if (typeof runtime.startBridge !== 'function' || typeof runtime.ensureAssets !== 'function') throw new Error('Missing exports');
    process.stdout.write('node-runtime-ready');
  `], { cwd: new URL('../', import.meta.url), encoding: 'utf8', timeout: 5000 });
  expect(result).toBe('node-runtime-ready');
});
