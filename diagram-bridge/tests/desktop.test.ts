import { expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDesktop } from '../desktop';

test('macOS opens the configured file using the registered bundle, without a shell', async () => {
  const calls: unknown[] = [];
  const filename = '/tmp/drawing with spaces;$(ignored).drawio.svg';
  expect(await openDesktop(filename, { platform: 'darwin', start: async (...args) => { calls.push(args); } })).toBe(true);
  expect(calls).toEqual([['open', ['-b', 'com.jgraph.drawio.desktop', filename], true]]);
});

test('missing desktop application falls back, but permissions and timeouts do not', async () => {
  for (const error of [{ code: 'ENOENT' }, { code: 1, stderr: 'Unable to find application with bundle identifier com.jgraph.drawio.desktop' }]) {
    expect(await openDesktop('/tmp/test.drawio.svg', { platform: 'darwin', start: async () => { throw error; } })).toBe(false);
  }
  for (const error of [{ code: 'EACCES' }, { code: 1, stderr: 'Application is not permitted' }, { killed: true }]) {
    await expect(openDesktop('/tmp/test.drawio.svg', { platform: 'darwin', start: async () => { throw error; } })).rejects.toThrow('permissions');
  }
});

test('Linux and Windows launch a discovered executable without waiting for the GUI to close', async () => {
  for (const platform of ['linux', 'win32'] as const) {
    const calls: unknown[] = [];
    expect(await openDesktop('/tmp/test.drawio.svg', { platform, find: () => '/installed/drawio', start: async (...args) => { calls.push(args); } })).toBe(true);
    expect(calls).toEqual([['/installed/drawio', ['/tmp/test.drawio.svg'], false]]);
  }
});

test('default executable lookup uses PATH and rejects non-executable files without Bun', async () => {
  if (process.platform === 'win32') return;
  const directory = mkdtempSync(join(tmpdir(), 'drawio-executable-test-'));
  const originalPath = process.env.PATH;
  const executable = join(directory, 'drawio');
  try {
    process.env.PATH = directory;
    writeFileSync(executable, 'not launched', { mode: 0o600 });
    let launched: string | undefined;
    const start = async (command: string) => { launched = command; };
    expect(await openDesktop('/tmp/test.drawio.svg', { platform: 'linux', start })).toBe(false);
    expect(launched).toBeUndefined();
    chmodSync(executable, 0o700);
    expect(await openDesktop('/tmp/test.drawio.svg', { platform: 'linux', start })).toBe(true);
    expect(launched).toBe(executable);
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    rmSync(directory, { recursive: true, force: true });
  }
});

test('unsupported hosts and absent Linux executable use the local browser instead', async () => {
  let calls = 0;
  for (const platform of ['linux', 'freebsd'] as const) {
    expect(await openDesktop('/tmp/test.drawio.svg', { platform, find: () => null, start: async () => { calls++; } })).toBe(false);
  }
  expect(calls).toBe(0);
});
