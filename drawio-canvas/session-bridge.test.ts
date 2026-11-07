import { afterEach, beforeEach, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { SessionBridges } from './session-bridge.mjs';
import { readRuntime, request } from './bridge.mjs';
import { emptyDrawing } from '../diagram-bridge/empty';

let home: string;
let managers: SessionBridges[];
beforeEach(() => { home = mkdtempSync(resolve(import.meta.dir, '.session-bridge-tests-')); managers = []; });
afterEach(async () => {
  await Promise.all(managers.map(manager => manager.stop()));
  rmSync(home, { recursive: true, force: true });
});
function fixtureAssets(root: string) {
  const files = {
    'index.html': '<script src="js/main.js"></script><link href="styles/grapheditor.css">',
    'js/app.min.js': 'EditorUi.VERSION="32.6.9";',
    'js/main.js': 'main', 'js/bootstrap.js': 'bootstrap',
    'js/grapheditor/Sidebar.js': "Sidebar.prototype.addGeneralPalette = function() { this.createVertexTemplateEntry('rounded=0;', 80, 80, '', 'Rectangle'); this.addEntry('list group erd table'",
    'styles/grapheditor.css': 'css', 'styles/high-contrast.css': 'css', 'mxgraph/mxClient.js': 'mxgraph',
    'img/lib/test/image.svg': '<svg viewBox="0 0 10 10"/>', 'images/icon.svg': '<svg/>',
    'resources/diagram.txt': 'resources', 'stencils/test.xml': '<shapes/>', 'shapes/test.js': 'shape', 'templates/test.xml': '<template/>',
  };
  for (const [file, data] of Object.entries(files)) {
    const filename = join(root, file);
    mkdirSync(resolve(filename, '..'), { recursive: true });
    writeFileSync(filename, data);
  }
  return root;
}
const manager = (options = {}) => {
  const assetsDir = join(home, 'assets');
  if (!existsSync(assetsDir)) fixtureAssets(assetsDir);
  const value = new SessionBridges({ home, assetsDir, sourceAssets: assetsDir, ...options });
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
  expect(fresh.services.size).toBe(0);
  const reuse = manager({ runtimePath: join(home, 'missing-runtime.mjs'), assetsDir: join(home, 'missing-assets') });
  expect(await reuse.runtimeFile('session-a')).toBe(pathA);
  expect(await reuse.runtimeFile('session-a')).toBe(pathA);
  expect(reuse.services.size).toBe(0);
  await reuse.stop();
  expect((await request(a, 'document')).xml).toBe(emptyDrawing());
  await first.stop();
  expect(first.services.size).toBe(0);
  await expect(request(a, 'document')).rejects.toMatchObject({ code: 'drawio_bridge_unavailable' });
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
    expect(fresh.services.size).toBe(0);
  }
  writeFileSync(pathA, original);
  expect(await first.runtimeFile('session-a')).toBe(pathA);
  expect(first.services.size).toBe(2);
});

const prerequisiteFailure = async (bridges: SessionBridges, code: string, remedy: string) => {
  await expect(bridges.runtimeFile('session-a')).rejects.toMatchObject({ code, message: expect.stringContaining(remedy) });
  expect(bridges.services.size).toBe(0);
};

const filesystemRuntime = () => ({
  ensureAssets: async ({ destination }: { destination: string }) => destination,
  startBridge: async () => { throw new Error('Unexpected bridge startup'); },
});

test('missing, unreadable and incompatible runtime bundles fail early without leaking paths', async () => {
  const incomplete = join(home, 'incomplete.mjs');
  writeFileSync(incomplete, 'export const startBridge = () => {};');
  const broken = join(home, 'broken.mjs');
  writeFileSync(broken, 'import "./credential-secret.mjs";');
  const unreadable = join(home, 'unreadable.mjs');
  writeFileSync(unreadable, '', { mode: 0o000 });
  try {
    for (const runtimePath of [join(home, 'credential-secret', 'missing.mjs'), home, 'relative.mjs', incomplete, broken, unreadable]) {
      const bridges = manager({ runtimePath });
      await prerequisiteFailure(bridges, 'drawio_install_incomplete', "Copilot's Install extension from repository action");
      await expect(bridges.runtimeFile('session-a')).rejects.toMatchObject({ message: expect.not.stringContaining('credential-secret') });
      expect(existsSync(bridges.directory('session-a'))).toBe(false);
    }
  } finally { chmodSync(unreadable, 0o600); }
});

test('asset preparation failures are actionable, sanitized and retryable', async () => {
  let calls = 0;
  const bridges = manager({ loadRuntime: async () => ({
    ...filesystemRuntime(),
    ensureAssets: async () => { calls++; throw new Error('https://user:credential-secret@fixture.invalid'); },
  }) });
  await prerequisiteFailure(bridges, 'drawio_assets_unavailable', 'Check network access');
  await expect(bridges.runtimeFile('session-a')).rejects.toMatchObject({ message: expect.not.stringContaining('credential-secret') });
  expect(calls).toBe(2);
  expect(existsSync(join(bridges.directory('session-a'), 'architecture.drawio.svg'))).toBe(false);
});

test('browser asset entry must be a readable file and explicit bad asset paths never fall back', async () => {
  const assetsDir = join(home, 'bad-assets');
  mkdirSync(join(assetsDir, 'index.html'), { recursive: true });
  const loadRuntime = async () => filesystemRuntime();
  await prerequisiteFailure(manager({ assetsDir, loadRuntime }), 'drawio_assets_unavailable', 'Desktop draw.io is optional');
  rmSync(join(assetsDir, 'index.html'), { recursive: true });
  writeFileSync(join(assetsDir, 'index.html'), '', { mode: 0o000 });
  try {
    await prerequisiteFailure(manager({ assetsDir, loadRuntime }), 'drawio_assets_unavailable', 'read/write permissions');
  } finally { chmodSync(join(assetsDir, 'index.html'), 0o600); }
  await prerequisiteFailure(manager({ assetsDir: 'relative-assets', loadRuntime }), 'drawio_assets_unavailable', 'DRAWIO_ASSETS');
  const incompatible = fixtureAssets(join(home, 'incompatible-assets'));
  writeFileSync(join(incompatible, 'js/app.min.js'), 'EditorUi.VERSION="0.0.0";');
  await prerequisiteFailure(manager({ sourceAssets: incompatible }), 'drawio_assets_unavailable', 'complete compatible local asset directory');
});

test('inaccessible storage and non-file drawing/runtime paths fail without replacing contents', async () => {
  const blocker = join(home, 'blocked-home');
  writeFileSync(blocker, 'preserve me');
  const loadRuntime = async () => filesystemRuntime();
  await prerequisiteFailure(manager({ home: blocker, loadRuntime }), 'drawio_storage_unavailable', 'Check COPILOT_HOME');
  await prerequisiteFailure(manager({ home: 'relative-home', loadRuntime }), 'drawio_storage_unavailable', 'Check COPILOT_HOME');
  expect(readFileSync(blocker, 'utf8')).toBe('preserve me');
  const bridges = manager({ loadRuntime });
  const directory = bridges.directory('session-a');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const drawing = join(directory, 'architecture.drawio.svg');
  writeFileSync(drawing, savedEmpty(), { mode: 0o400 });
  try {
    await prerequisiteFailure(bridges, 'drawio_storage_unavailable', 'restore read/write access without making private files public');
    expect(readFileSync(drawing, 'utf8')).toBe(savedEmpty());
    expect(statSync(drawing).mode & 0o777).toBe(0o400);
  } finally { chmodSync(drawing, 0o600); }
  for (const file of [drawing, join(directory, 'runtime.json')]) {
    rmSync(file, { force: true });
    mkdirSync(file);
    await prerequisiteFailure(bridges, 'drawio_storage_unavailable', 'not a regular file');
    expect(statSync(file).isDirectory()).toBe(true);
    rmSync(file, { recursive: true });
  }
});

test('invalid session IDs fail without creating drawings', async () => {
  const bridges = manager({ loadRuntime: async () => filesystemRuntime() });
  for (const id of ['../other', '/absolute/other', '', undefined]) expect(() => bridges.directory(id)).toThrow('valid session ID');
  await expect(bridges.runtimeFile('../other')).rejects.toMatchObject({ code: 'drawio_session_invalid' });
  expect(existsSync(join(home, 'session-state'))).toBe(false);
  expect(bridges.services.size).toBe(0);
});

test('first opens stage compatible assets once concurrently; later opens reuse the validated cache', async () => {
  const runtime = await import('./runtime.mjs');
  let preparations = 0;
  const assetsDir = join(home, 'prepared-assets');
  const bridges = manager({ assetsDir, loadRuntime: async () => ({
    ...runtime,
    ensureAssets: async (options: any) => {
      preparations++;
      return runtime.ensureAssets({ ...options, assets: undefined, candidates: [options.assets] });
    },
  }) });
  expect(existsSync(assetsDir)).toBe(false);
  const [a, b] = await Promise.all([bridges.runtimeFile('session-a'), bridges.runtimeFile('session-b')]);
  expect(preparations).toBe(1);
  expect(readFileSync(join(assetsDir, 'js/app.min.js'), 'utf8')).toContain('32.6.9');
  const cachedTime = statSync(join(assetsDir, 'index.html')).mtimeMs;
  await bridges.runtimeFile('session-c');
  expect(statSync(join(assetsDir, 'index.html')).mtimeMs).toBe(cachedTime);
  expect(bridges.services.size).toBe(3);
  expect((await request(readRuntime(a), 'document')).xml).toBe(emptyDrawing());
  expect((await request(readRuntime(b), 'document')).xml).toBe(emptyDrawing());
});

test('concurrent reopen after an owned bridge closes creates only one replacement', async () => {
  const bridges = manager();
  const runtimeFile = await bridges.runtimeFile('session-a');
  const previous = readRuntime(runtimeFile);
  await bridges.services.get('session-a').close();
  const [a, b] = await Promise.all([bridges.runtimeFile('session-a'), bridges.runtimeFile('session-a')]);
  expect(a).toBe(b);
  expect(readRuntime(a).url).not.toBe(previous.url);
  expect(bridges.services.size).toBe(1);
});

test('a reused port returning HTTP 401 restarts the session bridge without replacing its drawing', async () => {
  const bridges = manager();
  const runtimeFile = await bridges.runtimeFile('session-a');
  const previous = readRuntime(runtimeFile);
  const drawing = savedEmpty();
  writeFileSync(previous.filename, drawing);
  await bridges.services.get('session-a').close();
  let requests = 0;
  const otherBridge = createServer((_request, response) => {
    requests++;
    response.writeHead(401, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: `Authentication required ${previous.token}` }));
  });
  await new Promise<void>((resolve, reject) => {
    otherBridge.once('error', reject);
    otherBridge.listen(Number(new URL(previous.url).port), '127.0.0.1', resolve);
  });
  try {
    await expect(request(previous, 'document')).rejects.toMatchObject({
      code: 'drawio_request_failed', status: 401, message: 'Authentication required [redacted]',
    });
    const [a, b] = await Promise.all([bridges.runtimeFile('session-a'), bridges.runtimeFile('session-a')]);
    expect(a).toBe(runtimeFile);
    expect(b).toBe(a);
    expect(requests).toBe(2);
    expect(readRuntime(a).url).not.toBe(previous.url);
    expect(readRuntime(a).token).not.toBe(previous.token);
    expect((await request(readRuntime(a), 'document')).filename).toBe(previous.filename);
    expect(readFileSync(previous.filename, 'utf8')).toBe(drawing);
    expect(bridges.services.size).toBe(1);
  } finally { await new Promise<void>((resolve, reject) => otherBridge.close(error => error ? reject(error) : resolve())); }
});

test('HTTP conflicts and other request failures remain fatal when checking a saved runtime', async () => {
  const bridges = manager({ loadRuntime: async () => filesystemRuntime() });
  const directory = bridges.directory('session-a');
  mkdirSync(directory, { recursive: true });
  const runtimeFile = join(directory, 'runtime.json');
  const filename = join(directory, 'architecture.drawio.svg');
  const drawing = savedEmpty();
  writeFileSync(filename, drawing);
  let status = 409;
  const conflictingBridge = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => Response.json({ error: 'Do not retry' }, { status }) });
  const config = JSON.stringify({ url: `http://127.0.0.1:${conflictingBridge.port}`, token: 'a'.repeat(64), filename });
  writeFileSync(runtimeFile, config);
  try {
    for (status of [409, 400, 403, 500]) {
      await expect(bridges.runtimeFile('session-a')).rejects.toMatchObject({ code: status === 409 ? 'drawio_conflict' : 'drawio_request_failed', status });
      expect(readFileSync(runtimeFile, 'utf8')).toBe(config);
      expect(readFileSync(filename, 'utf8')).toBe(drawing);
      expect(bridges.services.size).toBe(0);
    }
  } finally { await conflictingBridge.stop(true); }
});

test('stopping during asset preparation prevents startup and waits without creating a service', async () => {
  let release!: () => void;
  let ready!: () => void;
  const started = new Promise<void>(resolve => { ready = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  let starts = 0;
  const bridges = manager({ loadRuntime: async () => ({
    ensureAssets: async ({ destination }: { destination: string }) => { ready(); await gate; return destination; },
    startBridge: async () => { starts++; throw new Error('Unexpected startup'); },
  }) });
  const opening = bridges.runtimeFile('session-a').catch(error => error);
  await started;
  const stopping = bridges.stop();
  release();
  expect(await opening).toMatchObject({ code: 'drawio_bridge_unavailable' });
  await stopping;
  expect(starts).toBe(0);
  expect(bridges.services.size).toBe(0);
  await expect(bridges.runtimeFile('session-b')).rejects.toMatchObject({ code: 'drawio_bridge_unavailable' });
});

test('stopping during bridge startup closes the newly acquired service exactly once', async () => {
  const runtime = await import('./runtime.mjs');
  let release!: () => void;
  let ready!: () => void;
  const started = new Promise<void>(resolve => { ready = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  let closes = 0;
  const bridges = manager({ loadRuntime: async () => ({
    ...runtime,
    startBridge: async (options: any) => {
      const service = await runtime.startBridge(options);
      ready(); await gate;
      return { ...service, close: async () => { closes++; await service.close(); } };
    },
  }) });
  const opening = bridges.runtimeFile('session-a');
  await started;
  const stopping = bridges.stop();
  release();
  const runtimeFile = await opening;
  const config = readRuntime(runtimeFile);
  await stopping;
  await bridges.stop();
  expect(closes).toBe(1);
  expect(bridges.services.size).toBe(0);
  await expect(request(config, 'document')).rejects.toMatchObject({ code: 'drawio_bridge_unavailable' });
});
