import { beforeEach, afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildShapeIndex, createShapeSearch, editorVersion } from '../shapes';
import { canvasOptions } from '../../drawio-canvas/canvas.mjs';
import { guidanceOptions } from '../../drawio-canvas/guidance.mjs';

let assets: string;
const style = 'rounded=0;whiteSpace=wrap;html=1;';
beforeEach(() => {
  assets = mkdtempSync(join(tmpdir(), 'drawio-shapes-'));
  for (const directory of ['js/grapheditor', 'img/lib/example']) mkdirSync(join(assets, directory), { recursive: true });
  writeFileSync(join(assets, 'js/app.min.js'), `EditorUi.VERSION="${editorVersion}";`);
  writeFileSync(join(assets, 'js/grapheditor/Sidebar.js'), `Sidebar.prototype.addGeneralPalette = function() {this.createVertexTemplateEntry('${style}', 120, 60, '', 'Rectangle');this.addEntry('list group erd table', function(){});};`);
  writeFileSync(join(assets, 'img/lib/example/Test_Service.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 10"><rect width="20" height="10"/></svg>');
});
afterEach(() => rmSync(assets, { recursive: true, force: true }));

test('returns exact core styles and usable image styles/dimensions without remote fallback', () => {
  const search = createShapeSearch(assets);
  expect(search({ query: 'rectangle' }).shapes[0]).toMatchObject({ label: 'Rectangle', style, width: 120, height: 60 });
  const result = search({ query: 'example test service', limit: 1 });
  expect(result).toMatchObject({ editorVersion, indexed: 2, total: 1 });
  expect(result.shapes[0]).toMatchObject({ label: 'Test Service', asset: '/drawio/img/lib/example/Test_Service.svg', width: 64, height: 32 });
  expect(result.shapes[0].style).toContain('image=img/lib/example/Test_Service.svg;');
  expect(search({ query: 'nonexistent' }).shapes).toEqual([]);
  expect(JSON.stringify(result)).not.toMatch(/https?:|icons\.diagrams\.net/);
});

test('schema and handler bound local queries and result limits', () => {
  const action = canvasOptions(Error, { bridges: {} }).actions.find(action => action.name === 'search_shapes')!;
  expect(action.inputSchema).toMatchObject({ additionalProperties: false, required: ['query'], properties: { query: { maxLength: 100 }, limit: { minimum: 1, maximum: 50 } } });
  const search = createShapeSearch(assets);
  for (const input of [{ query: '' }, { query: '  ' }, { query: '!@' }, { query: 'x'.repeat(101) }, { query: 'test', limit: 0 }, { query: 'test', limit: 51 }, { query: 'test', limit: 1.5 }, { query: 'test', remote: true }, { query: 5 }, null]) {
    expect(() => search(input as any)).toThrow('Provide a shape query');
  }
});

test('detects missing/mismatched assets instead of serving a stale index', () => {
  const search = createShapeSearch(assets);
  const initial = search({ query: 'test' });
  expect(search({ query: 'test' }).assetFingerprint).toBe(initial.assetFingerprint);
  writeFileSync(join(assets, 'img/lib/example/Test_Service.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 20"/>');
  expect(search({ query: 'test' }).assetFingerprint).not.toBe(initial.assetFingerprint);
  expect(search({ query: 'test' }).shapes[0].height).toBe(64);
  rmSync(join(assets, 'img/lib/example/Test_Service.svg'));
  expect(search({ query: 'test' }).shapes).toEqual([]);
  writeFileSync(join(assets, 'js/app.min.js'), 'EditorUi.VERSION="32.6.10";');
  expect(() => search({ query: 'rectangle' })).toThrow(editorVersion);
  rmSync(join(assets, 'js/app.min.js'));
  expect(() => search({ query: 'rectangle' })).toThrow('pinned local');
});

test('does not execute palette code or follow icon symlinks outside the asset directory', () => {
  const palette = join(assets, 'js/grapheditor/Sidebar.js');
  writeFileSync(palette, readFileSync(palette, 'utf8') + '\nthrow new Error("must not execute");');
  symlinkSync(join(assets, 'js/app.min.js'), join(assets, 'img/lib/example/linked.svg'));
  expect(buildShapeIndex(assets).shapes).toHaveLength(2);
});

test('the actual pinned local editor supports all indexed image paths and literal core styles', () => {
  const directory = resolve(import.meta.dir, '../vendor/drawio');
  const index = buildShapeIndex(directory);
  expect(index.editorVersion).toBe('32.6.9');
  expect(index.shapes.length).toBeGreaterThan(1700);
  expect(new Set(index.shapes.map(shape => shape.id)).size).toBe(index.shapes.length);
  for (const shape of index.shapes) {
    expect(shape.width).toBeGreaterThan(0);
    expect(shape.height).toBeGreaterThan(0);
    expect(shape.style).not.toMatch(/https?:|javascript:|\/\//i);
    if (shape.asset) {
      const image = shape.style.match(/(?:^|;)image=([^;]+);/)![1];
      expect(image).not.toStartWith('/');
      expect(shape.asset).toBe('/drawio/' + image);
      expect(existsSync(join(directory, decodeURIComponent(image)))).toBe(true);
    }
  }
  expect(createShapeSearch(directory)({ query: 'ai foundry' }).shapes[0].label).toBe('AI Foundry');
});

test('the bundled skill is discoverable through SDK tool and session context, with generic staged mechanics', async () => {
  const options = guidanceOptions();
  const tool = options.tools[0];
  expect(tool.name).toBe('drawio_get_guidance');
  expect(tool.parameters.additionalProperties).toBe(false);
  const result = await tool.handler();
  expect(result.resultType).toBe('success');
  expect(result.textResultForLlm).toContain('name: drawio');
  expect(result.textResultForLlm).toContain('savedRevision === revision');
  expect(result.textResultForLlm).toContain('Never blindly replay');
  expect(result.textResultForLlm).toContain('not necessarily `0` and `1`');
  expect(result.textResultForLlm).toContain('user-defined waypoints');
  expect(options.systemMessage.mode).toBe('append');
  expect(options.systemMessage.content).toContain(tool.name);
  expect(options.hooks).toBeUndefined();
});
