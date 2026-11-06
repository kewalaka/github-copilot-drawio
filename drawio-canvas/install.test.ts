import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { installExtension } from './install';
import { readRuntime, request } from './bridge.mjs';
import { emptyDrawing } from '../diagram-bridge/empty';

let home: string;
let bridges: any;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'drawio-install-')); bridges = undefined; });
afterEach(async () => {
  if (bridges) {
    const exits = Array.from(bridges.children, (child: any) => new Promise<void>(resolve => child.once('exit', () => resolve())));
    bridges.stop();
    await Promise.all(exits);
  }
  rmSync(home, { recursive: true, force: true });
});

test('portable installation bundles corrected session storage, discoverable skill, bridge and matched assets without touching existing drawings', async () => {
  const directory = join(home, 'session-state/existing-session/files/diagram-bridge');
  mkdirSync(directory, { recursive: true });
  const drawing = join(directory, 'architecture.drawio.svg');
  const xml = emptyDrawing().replace('id="0"', 'id="copy-root"').replace('id="1" parent="0"', 'id="copy-layer" parent="copy-root"');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" content="${xml.replaceAll('"', '&quot;').replaceAll('<', '&lt;')}"></svg>`;
  writeFileSync(drawing, svg);
  const settings = join(home, 'extensions/drawio-canvas/artifacts');
  mkdirSync(settings, { recursive: true });
  writeFileSync(join(settings, 'user-setting.txt'), 'preserve this');
  const destination = installExtension({ home });
  expect(readFileSync(drawing, 'utf8')).toBe(svg);
  expect(readFileSync(join(settings, 'user-setting.txt'), 'utf8')).toBe('preserve this');
  expect(readFileSync(join(destination, 'bridge/model.ts'), 'utf8')).toBe(readFileSync(new URL('../diagram-bridge/model.ts', import.meta.url), 'utf8'));
  expect(readFileSync(join(destination, 'bridge/public/app.js'), 'utf8')).toBe(readFileSync(new URL('../diagram-bridge/public/app.js', import.meta.url), 'utf8'));
  const installedEntry = readFileSync(join(destination, 'extension.mjs'), 'utf8');
  expect(installedEntry).toContain('new SessionBridges()');
  expect(installedEntry).toContain('...guidanceOptions()');
  const { guidanceOptions } = await import(pathToFileURL(join(destination, 'guidance.mjs')).href);
  expect((await guidanceOptions().tools[0].handler()).textResultForLlm).toContain('name: drawio');
  const { SessionBridges } = await import(pathToFileURL(join(destination, 'session-bridge.mjs')).href);
  bridges = new SessionBridges({ home, bun: process.execPath });
  const runtimeFile = await bridges.runtimeFile('existing-session');
  const runtime = readRuntime(runtimeFile);
  expect((await request(runtime, 'document')).xml).toContain('copy-root');
  expect((await request(runtime, 'shapes?query=rectangle&limit=1')).shapes[0].style).toContain('rounded=0;');
  expect(readFileSync(drawing, 'utf8')).toBe(svg);
  const { canvasOptions } = await import(pathToFileURL(join(destination, 'canvas.mjs')).href);
  const canvas = canvasOptions(Error, { bridges });
  expect(canvas.actions.map((action: any) => action.name)).toEqual(['search_shapes', 'read_document', 'apply_operations']);
  expect((await canvas.open({ sessionId: 'existing-session', instanceId: 'new-panel' })).url).toBe(runtime.url + '/');
  expect(readFileSync(drawing, 'utf8')).toBe(svg);
  expect(existsSync(join(settings, 'last-bridge.json'))).toBe(false);
});

test('dependency failure preserves the installed wrapper and bridge implementation', () => {
  const destination = join(home, 'extensions/drawio-canvas');
  mkdirSync(join(destination, 'bridge'), { recursive: true });
  writeFileSync(join(destination, 'extension.mjs'), 'existing wrapper');
  writeFileSync(join(destination, 'session-bridge.mjs'), 'existing SessionBridges');
  writeFileSync(join(destination, 'bridge/model.ts'), 'existing model');
  const install = spyOn(Bun, 'spawnSync').mockReturnValue({ exitCode: 1, stderr: Buffer.from('installation blocked') } as any);
  try {
    expect(() => installExtension({ home })).toThrow('do not reload');
    expect(readFileSync(join(destination, 'extension.mjs'), 'utf8')).toBe('existing wrapper');
    expect(readFileSync(join(destination, 'session-bridge.mjs'), 'utf8')).toBe('existing SessionBridges');
    expect(readFileSync(join(destination, 'bridge/model.ts'), 'utf8')).toBe('existing model');
    expect(existsSync(join(destination, 'artifacts/vendor'))).toBe(false);
  } finally { install.mockRestore(); }
});

test('missing assets fail before installing or overwriting extension files', () => {
  expect(() => installExtension({ home, assets: join(home, 'missing-assets') })).toThrow('pinned local');
  expect(existsSync(join(home, 'extensions'))).toBe(false);
});
