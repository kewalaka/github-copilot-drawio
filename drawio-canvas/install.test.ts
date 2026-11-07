import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { execFile } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { installExtension } from './install';
import { emptyDrawing } from '../diagram-bridge/empty';

let home: string;
let assets: string;
const execute = promisify(execFile);
beforeEach(() => {
  home = mkdtempSync(join(import.meta.dir, '.install-test-'));
  assets = join(home, 'source-assets');
  const files = {
    'index.html': '<script src="js/main.js"></script><link href="styles/grapheditor.css">',
    'js/app.min.js': 'EditorUi.VERSION="32.6.9";',
    'js/main.js': 'main', 'js/bootstrap.js': 'bootstrap',
    'js/grapheditor/Sidebar.js': "Sidebar.prototype.addGeneralPalette = function() { this.createVertexTemplateEntry('rounded=0;', 80, 80, '', 'Rectangle'); this.addEntry('list group erd table'",
    'styles/grapheditor.css': 'css', 'styles/high-contrast.css': 'css', 'mxgraph/mxClient.js': 'mxgraph',
    'img/lib/test/image.svg': '<svg viewBox="0 0 10 10"/>', 'images/icon.svg': '<svg/>',
    'resources/diagram.txt': 'resources', 'stencils/test.xml': '<shapes/>',
    'shapes/test.js': 'shape', 'templates/test.xml': '<template/>',
  };
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(assets, file)), { recursive: true });
    writeFileSync(join(assets, file), text);
  }
});
afterEach(() => { rmSync(home, { recursive: true, force: true }); });
const noDownload = async () => { throw new Error('Unexpected acquisition'); };
const wrapperFiles = ['extension.mjs', 'canvas.mjs', 'bridge.mjs', 'session-bridge.mjs', 'guidance.mjs', 'copilot-extension.json', 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.txt', 'runtime.mjs', 'build-manifest.json', 'skills'];
function sourceFixture() {
  const source = join(home, 'checkout/drawio-canvas'); mkdirSync(source, { recursive: true });
  for (const file of wrapperFiles) cpSync(join(import.meta.dir, file), join(source, file), { recursive: true });
  return source;
}
function existing() {
  const destination = join(home, 'extensions/drawio-canvas');
  mkdirSync(join(destination, 'artifacts'), { recursive: true });
  writeFileSync(join(destination, 'extension.mjs'), 'existing wrapper');
  writeFileSync(join(destination, 'runtime.mjs'), 'existing runtime');
  writeFileSync(join(destination, 'artifacts/runtime.json'), '{"private":"fixture-only-token"}');
  mkdirSync(join(home, 'session-state/session/files'), { recursive: true });
  writeFileSync(join(home, 'session-state/session/files/saved.svg'), 'saved fixture');
  return destination;
}
function privatePreserved(destination: string) {
  expect(readFileSync(join(destination, 'artifacts/runtime.json'), 'utf8')).toBe('{"private":"fixture-only-token"}');
  expect(readFileSync(join(home, 'session-state/session/files/saved.svg'), 'utf8')).toBe('saved fixture');
}
function oldPreserved(destination: string) {
  expect(readFileSync(join(destination, 'extension.mjs'), 'utf8')).toBe('existing wrapper');
  expect(readFileSync(join(destination, 'runtime.mjs'), 'utf8')).toBe('existing runtime');
  privatePreserved(destination);
}

async function nodeBridge(destination: string, { edit = false } = {}) {
  const { stdout } = await execute('node', ['--input-type=module', '-e', `
    import { readFileSync } from 'node:fs';
    import { join } from 'node:path';
    import { pathToFileURL } from 'node:url';
    const home = process.env.DRAWIO_TEST_HOME;
    const { startBridge, ensureAssets } = await import(pathToFileURL(join(home, 'extensions/drawio-canvas/runtime.mjs')));
    const directory = join(home, 'session-state/existing-session/files/diagram-bridge');
    const assets = await ensureAssets({ destination: join(home, 'extensions/drawio-canvas/artifacts/vendor/drawio') });
    const bridge = await startBridge({ filename: join(directory, 'architecture.drawio.svg'), runtimeFile: join(directory, 'runtime.json'), assets, publicFiles: {'style.css':'bad override'} });
    try {
      const runtime = JSON.parse(readFileSync(join(directory, 'runtime.json')));
      const request = async (path, body) => {
        const response = await fetch(bridge.url + '/api/' + path, { method: body ? 'POST' : 'GET', headers: { Authorization: 'Bearer ' + runtime.token }, ...(body ? {body: JSON.stringify(body)} : {}) });
        const result = await response.json();
        if (!response.ok) throw new Error(JSON.stringify(result));
        return result;
      };
      let document = await request('document');
      if (process.env.DRAWIO_TEST_EDIT === 'yes') {
        const editorId = 'durability-test';
        await request('editor', {editorId});
        const xml = document.xml.replace('</root>', '<mxCell id="durable-node" value="Saved edit before upgrade" vertex="1" parent="copy-layer"><mxGeometry x="37" y="51" width="120" height="60" as="geometry"/></mxCell></root>');
        const draft = await request('draft', {editorId, expectedRevision: document.revision, xml});
        const escaped = xml.replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;');
        await request('save', {editorId, expectedRevision: draft.revision, svg: '<svg xmlns="http://www.w3.org/2000/svg" content="' + escaped + '"><rect x="37" y="51" width="120" height="60"/></svg>'});
        document = await request('document');
      }
      const css = await fetch(bridge.url + '/style.css');
      const js = await fetch(bridge.url + '/app.js');
      const page = await fetch(bridge.url + '/');
      const shape = await request('shapes?query=rectangle&limit=1');
      console.log(JSON.stringify({xml:document.xml, dirty:document.dirty, cssType:css.headers.get('content-type'), css:await css.text(), jsType:js.headers.get('content-type'), js:await js.text(), page:await page.text(), shape:shape.shapes[0].style}));
    } finally { await bridge.close(); await bridge.close(); }
  `], { cwd: destination, env: { ...process.env, DRAWIO_TEST_HOME: home, DRAWIO_TEST_EDIT: edit ? 'yes' : 'no' }, timeout: 20_000, maxBuffer: 2_000_000 });
  return JSON.parse(stdout);
}

test('portable installation bundles a standalone Node runtime, skill and assets and reopens existing drawings', async () => {
  const destination = existing();
  const directory = join(home, 'session-state/existing-session/files/diagram-bridge'); mkdirSync(directory, { recursive: true });
  const drawing = join(directory, 'architecture.drawio.svg');
  const xml = emptyDrawing().replace('id="0"', 'id="copy-root"').replace('id="1" parent="0"', 'id="copy-layer" parent="copy-root"');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" content="${xml.replaceAll('"', '&quot;').replaceAll('<', '&lt;')}"></svg>`;
  writeFileSync(drawing, svg);
  expect(await installExtension({ home, assets, acquireAssets: noDownload })).toBe(destination);
  expect(readFileSync(join(destination, 'runtime.mjs'))).toEqual(readFileSync(join(import.meta.dir, 'runtime.mjs')));
  expect(readFileSync(join(destination, 'THIRD_PARTY_NOTICES.txt'), 'utf8')).toContain('@xmldom/xmldom 0.9.12');
  expect(readFileSync(join(destination, 'skills/drawio/SKILL.md'), 'utf8')).toContain('name: drawio');
  expect(existsSync(join(destination, 'bridge'))).toBe(false);
  expect(existsSync(join(destination, 'node_modules'))).toBe(false);
  const result = await nodeBridge(destination);
  expect(result.xml).toContain('copy-root');
  expect(result.shape).toContain('rounded=0;');
  expect(result.cssType).toContain('text/css');
  expect(result.css).toBe(readFileSync(join(import.meta.dir, '../diagram-bridge/public/style.css'), 'utf8'));
  expect(result.jsType).toContain('javascript');
  expect(result.js).toBe(readFileSync(join(import.meta.dir, '../diagram-bridge/public/app.js'), 'utf8'));
  expect(result.page).toBe(readFileSync(join(import.meta.dir, '../diagram-bridge/public/index.html'), 'utf8'));
  expect(readFileSync(drawing, 'utf8')).toBe(svg);
  privatePreserved(destination);
}, 30_000);

test('edited drawing survives manual upgrade and complete installed Node restart/reopen', async () => {
  const destination = existing();
  const directory = join(home, 'session-state/existing-session/files/diagram-bridge'); mkdirSync(directory, { recursive: true });
  const drawing = join(directory, 'architecture.drawio.svg');
  const xml = emptyDrawing().replace('id="0"', 'id="copy-root"').replace('id="1" parent="0"', 'id="copy-layer" parent="copy-root"');
  writeFileSync(drawing, `<svg xmlns="http://www.w3.org/2000/svg" content="${xml.replaceAll('"', '&quot;').replaceAll('<', '&lt;')}"></svg>`);
  await installExtension({ home, assets, acquireAssets: noDownload });
  const edited = await nodeBridge(destination, { edit: true });
  expect(edited.xml).toContain('Saved edit before upgrade'); expect(edited.dirty).toBe(false);
  const saved = readFileSync(drawing);
  writeFileSync(join(destination, 'extension.mjs'), 'older wrapper');
  await installExtension({ home, localAssets: join(home, 'missing'), acquireAssets: noDownload });
  const reopened = await nodeBridge(destination);
  expect(reopened.xml).toBe(edited.xml); expect(reopened.dirty).toBe(false);
  expect(readFileSync(drawing)).toEqual(saved);
  privatePreserved(destination);
}, 30_000);

test('incomplete/corrupt prebuilt runtime fails before replacing old code or private data', async () => {
  const destination = existing();
  const sourceDirectory = sourceFixture();
  writeFileSync(join(sourceDirectory, 'runtime.mjs'), 'corrupt deployment');
  await expect(installExtension({ home, assets, sourceDirectory, acquireAssets: noDownload })).rejects.toThrow('integrity');
  oldPreserved(destination);
  expect(existsSync(join(destination, 'artifacts/vendor'))).toBe(false);
});

test('missing explicitly selected assets reject before publishing implementation', async () => {
  const destination = existing();
  await expect(installExtension({ home, assets: join(home, 'missing'), acquireAssets: noDownload })).rejects.toThrow('Explicit DRAWIO_ASSETS');
  oldPreserved(destination);
});

test('staged wrapper build failure leaves installed implementation and private settings untouched', async () => {
  const destination = existing();
  const build = spyOn(Bun, 'build').mockResolvedValue({ success: false, logs: ['injected invalid wrapper'] } as any);
  try {
    await expect(installExtension({ home, assets, acquireAssets: noDownload })).rejects.toThrow('invalid wrapper');
    oldPreserved(destination);
  } finally { build.mockRestore(); }
});

test('late publication failure rolls back all implementation and asset replacements', async () => {
  const destination = existing();
  const move = (from: string, to: string) => { if (from.includes('/new/artifacts/vendor/drawio')) throw new Error('injected disk failure'); renameSync(from, to); };
  await expect(installExtension({ home, assets, acquireAssets: noDownload, move })).rejects.toThrow('disk failure');
  oldPreserved(destination);
  expect(existsSync(join(destination, 'artifacts/vendor/drawio'))).toBe(false);
});

test('source-distributed installer needs no node_modules or dependency-install subprocess', async () => {
  const sourceDirectory = sourceFixture();
  const destination = await installExtension({ home, sourceDirectory, assets, acquireAssets: noDownload });
  expect(existsSync(join(sourceDirectory, 'node_modules'))).toBe(false);
  expect(existsSync(join(destination, 'bridge/node_modules'))).toBe(false);
  expect(existsSync(join(destination, 'runtime.mjs'))).toBe(true);
});

test('installer lock prevents overlapping implementation publication', async () => {
  const destination = existing(); mkdirSync(join(home, 'extensions/.drawio-canvas-install.lock'));
  await expect(installExtension({ home, assets, acquireAssets: noDownload })).rejects.toThrow('Another installer');
  oldPreserved(destination);
});

test('symlinked installation home fails before writing outside the disposable home', async () => {
  const outside = join(home, 'outside'); mkdirSync(outside);
  symlinkSync(outside, join(home, 'linked-home'));
  await expect(installExtension({ home: join(home, 'linked-home'), assets, acquireAssets: noDownload })).rejects.toThrow('Unsafe installation directory');
  expect(existsSync(join(outside, 'extensions'))).toBe(false);
});

test('automatic acquisition failure leaves existing implementation and private files unchanged', async () => {
  const destination = existing();
  await expect(installExtension({ home, localAssets: join(home, 'missing'), acquireAssets: async () => { throw new Error('injected interrupted download'); } })).rejects.toThrow('interrupted download');
  oldPreserved(destination);
  expect(existsSync(join(destination, 'artifacts/vendor/drawio'))).toBe(false);
});

test('missing implicit assets are acquired and validated once before successful publication', async () => {
  let acquired = 0;
  const destination = await installExtension({ home, localAssets: join(home, 'missing'), acquireAssets: async () => { acquired++; return assets; } });
  expect(acquired).toBe(1);
  expect(readFileSync(join(destination, 'artifacts/vendor/drawio/js/app.min.js'), 'utf8')).toContain('32.6.9');
  expect(readFileSync(join(destination, 'runtime.mjs'))).toEqual(readFileSync(join(import.meta.dir, 'runtime.mjs')));
});
