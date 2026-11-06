import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SessionBridges } from './session-bridge.mjs';
import { readRuntime, request } from './bridge.mjs';
import { emptyDrawing } from '../diagram-bridge/empty';

let home: string;
let managers: SessionBridges[];
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'drawio-sessions-')); managers = []; });
afterEach(async () => {
  const children = managers.flatMap(manager => Array.from(manager.children));
  const exits = children.map(child => new Promise<void>(resolve => child.once('exit', () => resolve())));
  for (const manager of managers) manager.stop();
  await Promise.all(exits);
  rmSync(home, { recursive: true, force: true });
});
const manager = (options = {}) => {
  const value = new SessionBridges({ home, bun: process.execPath, bridgeDir: resolve(import.meta.dir, '../diagram-bridge'), assetsDir: resolve(import.meta.dir, '../diagram-bridge/vendor/drawio'), ...options });
  managers.push(value);
  return value;
};
const savedEmpty = () => `<svg xmlns="http://www.w3.org/2000/svg" content="${emptyDrawing().replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;')}"></svg>`;

test('separate sessions start separate bridges; provider restarts reuse saved drawings and private runtimes', async () => {
  const first = manager();
  const directory = first.directory('session-a');
  mkdirSync(directory, { recursive: true });
  const drawing = join(directory, 'architecture.drawio.svg');
  const before = savedEmpty();
  writeFileSync(drawing, before);
  const [pathA, concurrentA, pathB] = await Promise.all([first.runtimeFile('session-a'), first.runtimeFile('session-a'), first.runtimeFile('session-b')]);
  expect(pathA).toBe(concurrentA);
  expect(pathA).not.toBe(pathB);
  const a = readRuntime(pathA), b = readRuntime(pathB);
  expect(a.url).not.toBe(b.url);
  expect(a.filename).toBe(drawing);
  expect(b.filename).toBe(join(first.directory('session-b'), 'architecture.drawio.svg'));
  expect((await request(b, 'document')).xml).toBe(emptyDrawing());
  expect(readFileSync(drawing, 'utf8')).toBe(before);
  expect(statSync(pathA).mode & 0o777).toBe(0o600);
  expect(statSync(first.directory('session-b')).mode & 0o777).toBe(0o700);
  const fresh = manager();
  expect(await fresh.runtimeFile('session-a')).toBe(pathA);
  expect(readRuntime(pathA).url).toBe(a.url);
  expect(fresh.children.size).toBe(0);
  const children = Array.from(first.children);
  const stopped = Promise.all(children.map(child => new Promise<void>(resolve => child.once('exit', () => resolve()))));
  first.stop();
  await stopped;
  expect(await fresh.runtimeFile('session-a')).toBe(pathA);
  expect((await request(readRuntime(pathA), 'document')).dirty).toBe(false);
  expect(readFileSync(drawing, 'utf8')).toBe(before);
  expect(existsSync(join(home, 'extensions/drawio-canvas/artifacts/last-bridge.json'))).toBe(false);
});

test('cached and fresh providers reject another session drawing without replacing files or starting bridges', async () => {
  const first = manager();
  const directory = first.directory('session-a');
  mkdirSync(directory, { recursive: true });
  const svg = savedEmpty();
  writeFileSync(join(directory, 'architecture.drawio.svg'), svg);
  const pathA = await first.runtimeFile('session-a');
  const pathB = await first.runtimeFile('session-b');
  const original = readFileSync(pathA, 'utf8');
  const a = readRuntime(pathA), b = readRuntime(pathB);
  const fresh = manager();
  for (const replacement of [{ ...a, filename: b.filename }, { ...b, filename: a.filename }]) {
    writeFileSync(pathA, JSON.stringify(replacement));
    await expect(first.runtimeFile('session-a')).rejects.toMatchObject({ code: 'drawio_document_changed' });
    await expect(fresh.runtimeFile('session-a')).rejects.toMatchObject({ code: 'drawio_document_changed' });
    expect(readFileSync(pathA, 'utf8') === JSON.stringify(replacement)).toBe(true);
    expect(readFileSync(a.filename, 'utf8')).toBe(svg);
    expect(fresh.children.size).toBe(0);
  }
  writeFileSync(pathA, original);
  expect(await first.runtimeFile('session-a')).toBe(pathA);
  expect(first.children.size).toBe(2);
});

test('invalid session IDs and missing assets fail without creating or changing drawings', async () => {
  const bridges = manager({ assetsDir: join(home, 'missing-assets') });
  for (const id of ['../other', '/tmp/other', '', undefined]) expect(() => bridges.directory(id)).toThrow('valid session ID');
  await expect(bridges.runtimeFile('session-a')).rejects.toMatchObject({ code: 'drawio_assets_missing' });
  expect(existsSync(bridges.directory('session-a'))).toBe(false);
  expect(bridges.children.size).toBe(0);
});
