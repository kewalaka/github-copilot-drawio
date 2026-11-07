import { test as base, expect, type Page } from '@playwright/test';
import { spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyOperations, diagramXml, parse, topology } from '../model';
import { canvasOptions } from '../../drawio-canvas/canvas.mjs';
import { seed } from '../seed';

type Runtime = { url: string; token: string; filename: string };
const nodeExecutable = process.versions.bun ? Bun.which('node') : process.execPath;
if (!nodeExecutable) throw new Error('Node is needed for development browser tests');
const test = base.extend<{ bridge: Runtime & { restart: () => Promise<Runtime>; runtimePath: string; temp: string } }>({
  bridge: async ({}, use) => {
    const temp = mkdtempSync(join(tmpdir(), 'diagram-bridge-test-'));
    const runtimePath = join(temp, 'runtime.json');
    writeFileSync(join(temp, 'test.drawio.svg'), `<svg xmlns="http://www.w3.org/2000/svg" content="${seed().replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;')}"></svg>`);
    let child: ReturnType<typeof spawn>;
    async function stop() {
      if (!child || child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
      child.kill('SIGTERM');
      await exited;
    }
    async function start(): Promise<Runtime> {
      rmSync(runtimePath, { force: true });
      child = spawn(nodeExecutable, ['--input-type=module', '--eval', `
        import { resolve } from 'node:path';
        import { startBridge } from '../drawio-canvas/runtime.mjs';
        if (process.versions.bun) throw new Error('Production bridge must run in Node');
        await startBridge({
          filename: process.env.DIAGRAM_FILE,
          runtimeFile: process.env.BRIDGE_RUNTIME,
          assets: process.env.DRAWIO_ASSETS ?? resolve('vendor/drawio'),
          port: 0,
        });
      `], {
        cwd: import.meta.dirname + '/..', env: { ...process.env, PATH: '', DIAGRAM_FILE: join(temp, 'test.drawio.svg'), BRIDGE_RUNTIME: runtimePath },
        stdio: 'pipe',
      });
      let output = '';
      child.stderr!.on('data', chunk => output += chunk);
      for (let i = 0; !existsSync(runtimePath) && child.exitCode === null && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 50));
      if (!existsSync(runtimePath)) throw new Error('Test server failed: ' + output);
      return JSON.parse(readFileSync(runtimePath, 'utf8'));
    }
    try {
      await use({ ...await start(), runtimePath, temp, restart: async () => { await stop(); return start(); } });
    } finally {
      await stop();
      rmSync(temp, { recursive: true, force: true });
    }
  },
});
test('Node HTTP boundary rejects foreign hosts, origins, unauthenticated requests and private asset paths', async ({ bridge }) => {
  const foreignHostStatus = await new Promise<number | undefined>((resolve, reject) => {
    const request = httpRequest(bridge.url + '/health', { headers: { Host: 'localhost' } }, response => {
      response.resume();
      response.once('end', () => resolve(response.statusCode));
    });
    request.once('error', reject);
    request.end();
  });
  expect(foreignHostStatus).toBe(403);
  expect((await fetch(bridge.url + '/api/document')).status).toBe(401);
  expect((await fetch(bridge.url + '/api/editor', {
    method: 'POST', headers: { Authorization: `Bearer ${bridge.token}`, Origin: 'http://localhost' },
    body: JSON.stringify({ editorId: 'foreign-origin' }),
  })).status).toBe(403);
  expect((await fetch(bridge.url + '/api/editor', {
    method: 'POST', headers: { Authorization: `Bearer ${bridge.token}` }, body: '{',
  })).status).toBe(400);
  for (const path of ['/drawio/WEB-INF/web.xml', '/drawio/META-INF/MANIFEST.MF', '/drawio/%2e%2e%2fprivate']) {
    expect((await fetch(bridge.url + path)).status).toBe(403);
  }
  expect((await fetch(bridge.url + '/does-not-exist')).status).toBe(404);
  expect((await fetch(bridge.url + '/style.css')).headers.get('content-type')).toBe('text/css');
  expect((await fetch(bridge.url + '/health')).status).toBe(200);
});

test('Node HTTP boundary caps both declared and chunked request bodies without losing the bridge', async ({ bridge }) => {
  const headers = { Authorization: `Bearer ${bridge.token}` };
  expect((await fetch(bridge.url + '/api/editor', {
    method: 'POST', headers, body: Buffer.alloc(24_000_001, 32),
  })).status).toBe(413);
  const status = await new Promise<number | undefined>((resolve, reject) => {
    const request = httpRequest(bridge.url + '/api/editor', {
      method: 'POST', headers: { ...headers, 'Transfer-Encoding': 'chunked' },
    }, response => {
      response.resume();
      response.once('end', () => resolve(response.statusCode));
    });
    request.once('error', reject);
    request.write(Buffer.alloc(12_000_000, 32));
    request.end(Buffer.alloc(12_000_001, 32));
  });
  expect(status).toBe(413);
  expect((await fetch(bridge.url + '/health')).status).toBe(200);
});

const geometry = (xml: string, id: string) => {
  const cell = Array.from(parse(diagramXml(xml)).getElementsByTagName('mxCell')).find(c => c.getAttribute('id') === id)!;
  return cell.getElementsByTagName('mxGeometry')[0].toString();
};

async function dragFunction(page: Page) {
  const images = await page.frameLocator('#editor').locator('image').filter({ visible: true }).evaluateAll(elements => elements.map(img => ({
    href: img.getAttribute('xlink:href') || img.getAttribute('href') || '', rect: img.getBoundingClientRect().toJSON(),
  })));
  const icon = images.find(img => img.href.includes('Function_Apps'));
  expect(icon).toBeTruthy();
  const bounds = await page.locator('#editor').boundingBox();
  const x = bounds!.x + icon!.rect.x + icon!.rect.width / 2;
  const y = bounds!.y + icon!.rect.y + icon!.rect.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 75, y + 30, { steps: 15 });
  await page.mouse.up();
}

test('canvas handlers preserve manual layout, refuse stale revisions and rehydrate saved SVG', async ({ page, bridge }) => {
  class CanvasError extends Error {
    constructor(public code: string, message: string) { super(message); }
  }
  const bridges = { runtimeFile: async () => bridge.runtimePath };
  const options = canvasOptions(CanvasError, { bridges });
  const panel = { instanceId: 'drawio-test', input: { runtimeFile: bridge.runtimePath } };
  const action = (name: string) => options.actions.find(item => item.name === name)!.handler;
  const read = () => action('read_document')({ instanceId: panel.instanceId, input: {} });
  const opened = await options.open(panel);
  await page.goto(opened.url);
  await expect(page.locator('#status')).toContainText('Saved', { timeout: 30_000 });
  const initial = await read();
  await dragFunction(page);
  await expect.poll(async () => geometry((await read()).xml, 'function')).not.toBe(geometry(initial.xml, 'function'));
  await expect.poll(async () => !(await read()).dirty).toBeTruthy();
  const manual = await read();
  const operation = { kind: 'update', id: 'function', label: 'Canvas-controlled ingestion' };
  await expect(action('apply_operations')({ instanceId: panel.instanceId, input: {
    expectedRevision: initial.revision, operations: [operation],
  } })).rejects.toMatchObject({ code: 'drawio_conflict' });
  await expect(action('apply_operations')({ instanceId: panel.instanceId, input: {
    expectedRevision: manual.revision, operations: [{ ...operation, geometry: { x: 0, y: 0, width: 120, height: 70 } }],
  } })).rejects.toThrow('relayout');
  const saved = await action('apply_operations')({ instanceId: panel.instanceId, input: {
    expectedRevision: manual.revision, operations: [operation],
  } });
  expect(saved.filename).toBe(bridge.filename);
  const updated = await read();
  expect(updated.savedRevision).toBe(updated.revision);
  expect(geometry(updated.xml, 'function')).toBe(geometry(manual.xml, 'function'));
  await expect(page.frameLocator('#editor').getByText(operation.label, { exact: true })).toBeVisible();
  const savedSvg = readFileSync(bridge.filename, 'utf8');
  expect(topology(diagramXml(savedSvg))).toBe(topology(updated.xml));
  await bridge.restart();
  const rehydrated = canvasOptions(CanvasError, { bridges });
  const freshPanel = { instanceId: 'new-panel', input: undefined };
  await page.goto((await rehydrated.open(freshPanel)).url);
  await expect(page.locator('#status')).toContainText('Saved', { timeout: 30_000 });
  await expect(page.frameLocator('#editor').getByText(operation.label, { exact: true })).toBeVisible();
  expect(readFileSync(bridge.filename, 'utf8')).toBe(savedSvg);
});

test('duplicated pages save, accept page-specific operations and reopen with their IDs intact', async ({ page, request, bridge }) => {
  const headers = { Authorization: `Bearer ${bridge.token}` };
  const read = async () => (await request.get(bridge.url + '/api/document', { headers })).json();
  const firstPage = (xml: string) => topology(`<mxfile>${parse(diagramXml(xml)).getElementsByTagName('diagram')[0]}</mxfile>`);
  await page.goto(bridge.url);
  await expect(page.locator('#status')).toContainText('Saved', { timeout: 30_000 });
  const initial = await read();
  const editor = page.frameLocator('#editor');
  await editor.locator('.geTab').filter({ hasText: 'Resource organisation' }).first().click({ button: 'right' });
  await editor.getByText('Duplicate Page', { exact: true }).click();
  await expect.poll(async () => parse((await read()).xml).getElementsByTagName('diagram').length, { timeout: 20_000 }).toBe(2);
  await expect(page.locator('#status')).toContainText('Saved');
  const duplicated = await read();
  const copy = parse(duplicated.xml).getElementsByTagName('diagram')[1];
  const cells = Array.from(copy.getElementsByTagName('mxCell'));
  const root = cells.find(c => !c.hasAttribute('parent'))!;
  const layer = cells.find(c => c.getAttribute('parent') === root.getAttribute('id'))!;
  const component = cells.find(c => c.getAttribute('value') === 'Ingestion Function App')!;
  expect(root.getAttribute('id')).not.toBe('0');
  expect(layer.getAttribute('id')).not.toBe('1');
  expect(firstPage(duplicated.xml)).toBe(firstPage(initial.xml));
  const response = await request.post(bridge.url + '/api/operations', { headers, data: {
    expectedRevision: duplicated.revision, pageId: copy.getAttribute('id'), operations: [
      { kind: 'update', id: component.getAttribute('id'), label: 'API Gateway (AWS)' },
      { kind: 'add', id: 'mcp', label: 'MCP', geometry: { x: 20, y: 20, width: 100, height: 60 } },
    ],
  } });
  expect(response.status()).toBe(202);
  const job = await response.json();
  await expect.poll(async () => (await (await request.get(bridge.url + '/api/jobs/' + job.id, { headers })).json()).status,
    { timeout: 30_000 }).toBe('completed');
  const final = await read();
  const finalCopy = parse(final.xml).getElementsByTagName('diagram')[1];
  const added = Array.from(finalCopy.getElementsByTagName('mxCell')).find(c => c.getAttribute('id') === 'mcp')!;
  expect(added.getAttribute('parent')).toBe(layer.getAttribute('id'));
  expect(geometry(final.xml, component.getAttribute('id')!)).toBe(geometry(duplicated.xml, component.getAttribute('id')!));
  expect(firstPage(final.xml)).toBe(firstPage(initial.xml));
  expect(topology(diagramXml(readFileSync(bridge.filename, 'utf8')))).toBe(topology(final.xml));
  const reopened = await bridge.restart();
  await page.goto(reopened.url);
  await expect(page.locator('#status')).toContainText('Saved', { timeout: 30_000 });
  await editor.locator('.geTab').filter({ hasText: copy.getAttribute('name')! }).first().click();
  await expect(editor.getByText('API Gateway (AWS)', { exact: true })).toBeVisible();
  await expect(editor.getByText('MCP', { exact: true })).toBeVisible();
});

test('rejected manual drafts still warn before closing and can be saved after retry', async ({ page, request, bridge }) => {
  const headers = { Authorization: `Bearer ${bridge.token}` };
  await page.goto(bridge.url);
  await expect(page.locator('#status')).toContainText('Saved', { timeout: 30_000 });
  await expect(page.getByRole('button', { name: 'Retry save', includeHidden: true })).toBeHidden();
  const savedSvg = readFileSync(bridge.filename, 'utf8');
  await page.route('**/api/draft', route => route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'Rejected test draft' }) }));
  await dragFunction(page);
  await expect(page.locator('#status')).toContainText('Rejected test draft');
  await expect(page.getByRole('button', { name: 'Retry save' })).toBeEnabled();
  const document = await (await request.get(bridge.url + '/api/document', { headers })).json();
  expect(document.dirty).toBe(false);
  expect(readFileSync(bridge.filename, 'utf8')).toBe(savedSvg);
  const warns = () => page.evaluate(() => {
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(await warns()).toBe(true);
  await page.unroute('**/api/draft');
  await page.locator('#save').click();
  await expect(page.locator('#status')).toContainText('Saved');
  expect(await warns()).toBe(false);
  await expect(page.locator('#save')).toBeHidden();
  expect(readFileSync(bridge.filename, 'utf8')).not.toBe(savedSvg);
});

test('retry save is shown only after failed autosave, stays usable after failure and hides after success', async ({ page, request, bridge }) => {
  const headers = { Authorization: `Bearer ${bridge.token}` };
  const read = async () => (await request.get(bridge.url + '/api/document', { headers })).json();
  await page.goto(bridge.url);
  await expect(page.locator('#status')).toContainText('Saved', { timeout: 30_000 });
  const retry = page.locator('#save');
  await expect(retry).toBeHidden();
  const original = await read();
  const savedSvg = readFileSync(bridge.filename, 'utf8');
  let held: Promise<void> | undefined;
  await page.route('**/api/save', async route => {
    await held;
    await route.fulfill({ status: 500, json: { error: 'Injected autosave failure' } });
  });
  await dragFunction(page);
  await expect(page.locator('#status')).toContainText('Injected autosave failure');
  await expect(retry).toBeVisible();
  await expect(retry).toBeEnabled();
  expect((await read()).dirty).toBe(true);
  expect(readFileSync(bridge.filename, 'utf8')).toBe(savedSvg);
  let release!: () => void;
  held = new Promise<void>(resolve => { release = resolve; });
  const failedRetry = page.waitForResponse(response => response.url().endsWith('/api/save') && response.status() === 500);
  await retry.click();
  await expect(retry).toBeDisabled();
  release();
  await failedRetry;
  await expect(retry).toBeEnabled();
  expect(readFileSync(bridge.filename, 'utf8')).toBe(savedSvg);
  await page.unroute('**/api/save');
  await retry.click();
  await expect(page.locator('#status')).toContainText('Saved');
  await expect(retry).toBeHidden();
  const saved = await read();
  expect(saved.dirty).toBe(false);
  expect(saved.savedRevision).toBe(saved.revision);
  expect(geometry(saved.xml, 'function')).not.toBe(geometry(original.xml, 'function'));
  expect(topology(diagramXml(readFileSync(bridge.filename, 'utf8')))).toBe(topology(saved.xml));
  await dragFunction(page);
  await expect.poll(async () => geometry((await read()).xml, 'function')).not.toBe(geometry(saved.xml, 'function'));
  await expect.poll(async () => (await read()).dirty).toBe(false);
  await expect(retry).toBeHidden();
});

test('a successful agent save clears a previous autosave retry without losing the manual draft', async ({ page, request, bridge }) => {
  const headers = { Authorization: `Bearer ${bridge.token}` };
  const read = async () => (await request.get(bridge.url + '/api/document', { headers })).json();
  await page.goto(bridge.url);
  await expect(page.locator('#status')).toContainText('Saved', { timeout: 30_000 });
  await page.route('**/api/save', route => route.fulfill({ status: 500, json: { error: 'Injected autosave failure' } }));
  await dragFunction(page);
  await expect(page.locator('#save')).toBeVisible();
  const manual = await read();
  await page.unroute('**/api/save');
  const job = await (await request.post(bridge.url + '/api/operations', { headers, data: {
    expectedRevision: manual.revision, operations: [{ kind: 'update', id: 'function', label: 'Saved with manual draft' }],
  } })).json();
  await expect.poll(async () => (await (await request.get(bridge.url + '/api/jobs/' + job.id, { headers })).json()).status,
    { timeout: 30_000 }).toBe('completed');
  await expect(page.locator('#save')).toBeHidden();
  const saved = await read();
  expect(saved.dirty).toBe(false);
  expect(geometry(saved.xml, 'function')).toBe(geometry(manual.xml, 'function'));
  expect(await page.evaluate(() => {
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  })).toBe(false);
});

test('manual drag → agent update → embedded SVG reopen, entirely local', async ({ page, request, bridge }) => {
  const external: string[] = [];
  page.on('request', req => { if (!req.url().startsWith(bridge.url) && !/^(data|blob):/.test(req.url())) external.push(req.url()); });
  const headers = { Authorization: `Bearer ${bridge.token}` };
  const read = async () => (await request.get(bridge.url + '/api/document', { headers })).json();
  await page.goto(bridge.url);
  await expect(page.locator('#status')).toContainText('Saved', { timeout: 30_000 });
  expect(existsSync(bridge.filename)).toBeTruthy();
  const initial = await read();
  await dragFunction(page);
  await expect.poll(async () => geometry((await read()).xml, 'function'), { timeout: 20_000 }).not.toBe(geometry(initial.xml, 'function'));
  await expect.poll(async () => { const d = await read(); return d.savedRevision === d.revision; }).toBeTruthy();
  const manuallyEdited = await read();
  const update = await request.post(bridge.url + '/api/operations', { headers, data: {
    expectedRevision: manuallyEdited.revision,
    operations: [{ kind: 'update', id: 'function', label: 'Event ingestion processor' }, {
      kind: 'add', id: 'monitor', parent: 'rg-app', label: 'Application Insights', geometry: { x: 620, y: 82, width: 120, height: 70 },
    }],
  } });
  expect(update.status()).toBe(202);
  const job = await update.json();
  await expect.poll(async () => (await (await request.get(bridge.url + '/api/jobs/' + job.id, { headers })).json()).status,
    { timeout: 30_000 }).toBe('completed');
  const updated = await read();
  expect(updated.xml).toContain('Event ingestion processor');
  expect(updated.xml).toContain('Application Insights');
  expect(geometry(updated.xml, 'function')).toBe(geometry(manuallyEdited.xml, 'function'));
  const savedSvg = readFileSync(bridge.filename, 'utf8');
  expect(savedSvg).toContain('<svg');
  expect(savedSvg).toContain('data:image/svg+xml;base64');
  expect(topology(diagramXml(savedSvg))).toBe(topology(updated.xml));
  await page.reload();
  await expect(page.locator('#status')).toContainText('Saved', { timeout: 30_000 });
  await expect(page.frameLocator('#editor').getByText('Event ingestion processor', { exact: true })).toBeVisible();
  expect(geometry((await read()).xml, 'function')).toBe(geometry(manuallyEdited.xml, 'function'));
  expect(external).toEqual([]);
  await page.screenshot({ path: 'test-results/verified-editor.png' });
  const reopened = await bridge.restart();
  await page.goto(reopened.url);
  await expect(page.locator('#status')).toContainText('Saved', { timeout: 30_000 });
  await expect(page.frameLocator('#editor').getByText('Event ingestion processor', { exact: true })).toBeVisible();
  const restored = await (await request.get(reopened.url + '/api/document', { headers: { Authorization: `Bearer ${reopened.token}` } })).json();
  expect(topology(restored.xml)).toBe(topology(updated.xml));
  expect(readFileSync(bridge.filename, 'utf8')).toBe(savedSvg);
});

test('rejects stale updates, external writes and unauthenticated mutation', async ({ page, request, bridge }) => {
  const headers = { Authorization: `Bearer ${bridge.token}` };
  await page.goto(bridge.url);
  await expect(page.locator('#status')).toContainText('Saved', { timeout: 30_000 });
  const current = await (await request.get(bridge.url + '/api/document', { headers })).json();
  const operations = [{ kind: 'update', id: 'storage', label: 'Do not overwrite' }];
  expect((await request.post(bridge.url + '/api/operations', { data: { operations, expectedRevision: current.revision } })).status()).toBe(401);
  expect((await request.post(bridge.url + '/api/operations', { headers: { ...headers, Origin: 'https://example.com' }, data: { operations, expectedRevision: current.revision } })).status()).toBe(403);
  expect((await request.post(bridge.url + '/api/operations', { headers, data: { operations, expectedRevision: current.revision - 1 } })).status()).toBe(409);
  const external = readFileSync(bridge.filename, 'utf8').replace('Ingestion Function App', 'Externally edited Function App');
  writeFileSync(bridge.filename, external);
  expect((await request.post(bridge.url + '/api/operations', { headers, data: { operations, expectedRevision: current.revision } })).status()).toBe(409);
  expect(readFileSync(bridge.filename, 'utf8')).toBe(external);
  expect((await request.get(bridge.url + '/diagram.svg')).status()).toBe(409);
});

test('failed agent save restores the live diagram and releases the save lock', async ({ page, request, bridge }) => {
  const headers = { Authorization: `Bearer ${bridge.token}` };
  const read = async () => (await request.get(bridge.url + '/api/document', { headers })).json();
  await page.goto(bridge.url);
  await expect(page.locator('#status')).toContainText('Saved', { timeout: 30_000 });
  const before = await read();
  const savedSvg = readFileSync(bridge.filename, 'utf8');
  await page.route('**/api/commit', route => route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'Injected save failure' }) }));
  const queue = async () => (await request.post(bridge.url + '/api/operations', { headers, data: {
    expectedRevision: (await read()).revision, operations: [{ kind: 'update', id: 'function', label: 'Agent recovery test' }],
  } })).json();
  const job = await queue();
  const result = async () => (await (await request.get(bridge.url + '/api/jobs/' + job.id, { headers })).json()).status;
  await expect.poll(result, { timeout: 30_000 }).toBe('failed');
  await expect(page.locator('#busy')).toBeHidden();
  await expect(page.frameLocator('#editor').getByText('Ingestion Function App', { exact: true })).toBeVisible();
  expect(topology((await read()).xml)).toBe(topology(before.xml));
  expect(readFileSync(bridge.filename, 'utf8')).toBe(savedSvg);
  await expect(page.locator('#save')).toBeHidden();
  await page.unroute('**/api/commit');
  const retry = await queue();
  await expect.poll(async () => (await (await request.get(bridge.url + '/api/jobs/' + retry.id, { headers })).json()).status,
    { timeout: 30_000 }).toBe('completed');
  await expect(page.frameLocator('#editor').getByText('Agent recovery test', { exact: true })).toBeVisible();
});

test('agent command retries an intervening manual edit without losing its layout', async ({ page, request, bridge }) => {
  const headers = { Authorization: `Bearer ${bridge.token}` };
  const read = async () => (await request.get(bridge.url + '/api/document', { headers })).json();
  await page.goto(bridge.url);
  await expect(page.locator('#status')).toContainText('Saved', { timeout: 30_000 });
  let release!: () => void;
  const held = new Promise<void>(resolve => release = resolve);
  await page.route('**/api/jobs?editorId=*', async route => { await held; await route.continue(); });
  const initial = await read();
  const editorId = await page.evaluate(() => sessionStorage.bridgeEditorId);
  const operationFile = join(bridge.temp, 'operations.json');
  writeFileSync(operationFile, JSON.stringify({ operations: [{ kind: 'update', id: 'function', label: 'Concurrent edit preserved' }] }));
  const agent = spawn('bun', ['run', 'agent.ts', operationFile], {
    cwd: import.meta.dirname + '/..', env: { ...process.env, BRIDGE_RUNTIME: bridge.runtimePath }, stdio: 'pipe',
  });
  let output = '';
  agent.stderr!.on('data', chunk => output += chunk);
  try {
    await expect.poll(async () => (await (await request.get(bridge.url + '/api/jobs?editorId=' + editorId, { headers })).json()).job?.status).toBe('queued');
    await dragFunction(page);
    await expect.poll(async () => geometry((await read()).xml, 'function'), { timeout: 20_000 }).not.toBe(geometry(initial.xml, 'function'));
    await expect.poll(async () => { const d = await read(); return !d.dirty; }).toBeTruthy();
    const manual = await read();
    release();
    await expect.poll(() => agent.exitCode, { timeout: 35_000 }).toBe(0);
    expect(output).toContain('re-reading and retrying');
    const final = await read();
    expect(final.xml).toContain('Concurrent edit preserved');
    expect(geometry(final.xml, 'function')).toBe(geometry(manual.xml, 'function'));
    expect(topology(diagramXml(readFileSync(bridge.filename, 'utf8')))).toBe(topology(final.xml));
  } finally {
    release();
    if (agent.exitCode === null && agent.signalCode === null) {
      const exited = new Promise<void>(resolve => agent.once('exit', () => resolve()));
      agent.kill('SIGTERM');
      await exited;
    }
  }
});

test('local shape lookup supports progressive saved stages; later conflicts/failures preserve layout and completed work', async ({ page, request, bridge }) => {
  class CanvasError extends Error {
    constructor(public code: string, message: string) { super(message); }
  }
  const options = canvasOptions(CanvasError, { bridges: { runtimeFile: async () => bridge.runtimePath } });
  const panel = { sessionId: 'progressive-test', instanceId: 'progressive-panel' };
  const invoke = (name: string, input = {}) => options.actions.find(action => action.name === name)!.handler({ ...panel, input });
  const read = () => invoke('read_document');
  const opened = await options.open({ ...panel, input: undefined });
  const external: string[] = [];
  const localUrls = [bridge.url];
  page.on('request', request => {
    if (!localUrls.some(url => request.url().startsWith(url + '/')) && !/^(data|blob):/.test(request.url())) external.push(request.url());
  });
  await page.goto(opened.url);
  await expect(page.locator('#status')).toContainText('Saved', { timeout: 30_000 });
  await expect(page.locator('#save')).toBeHidden();
  const headers = { Authorization: `Bearer ${bridge.token}` };
  expect((await request.get(bridge.url + '/api/shapes?query=rectangle')).status()).toBe(401);
  for (const query of ['query=rectangle&limit=51', 'query=rectangle&remote=true', 'query=rectangle&query=cloud']) {
    expect((await request.get(bridge.url + '/api/shapes?' + query, { headers })).status()).toBe(400);
  }
  const seeded = await read();
  await dragFunction(page);
  await expect.poll(async () => geometry((await read()).xml, 'function')).not.toBe(geometry(seeded.xml, 'function'));
  await expect.poll(async () => !(await read()).dirty).toBeTruthy();
  const initial = await read();
  const pageId = parse(initial.xml).getElementsByTagName('diagram')[0].getAttribute('id');
  const rectangle = (await invoke('search_shapes', { query: 'rectangle', limit: 1 })).shapes[0];
  const icons = await invoke('search_shapes', { query: 'ai foundry', limit: 1 });
  const icon = icons.shapes[0];
  expect(icons.editorVersion).toBe('32.6.9');
  expect(icon.asset).toContain('/drawio/img/lib/');
  expect((await request.get(bridge.url + icon.asset)).status()).toBe(200);
  const stages = [
    [{ kind: 'add', id: 'stage-boundary', label: 'System boundary', style: rectangle.style, geometry: { x: 1500, y: 100, width: 500, height: 400 } }],
    [
      { kind: 'add', id: 'stage-resource', parent: 'stage-boundary', label: 'Platform', style: rectangle.style, geometry: { x: 30, y: 70, width: 220, height: 270 } },
      { kind: 'add', id: 'stage-consumer', parent: 'stage-boundary', label: 'Consumer', style: rectangle.style, geometry: { x: 300, y: 110, width: 150, height: 80 } },
    ],
    [{ kind: 'add', id: 'stage-content', parent: 'stage-resource', label: 'Local icon', style: icon.style, geometry: { x: 40, y: 60, width: icon.width, height: icon.height } }],
    [{ kind: 'add', id: 'stage-link', source: 'stage-content', target: 'stage-consumer', label: 'Service calls', relation: 'data' }],
  ];
  let firstStageRevision: number | undefined;
  for (const operations of stages) {
    const before = await read();
    const saved = await invoke('apply_operations', { expectedRevision: before.revision, pageId, operations });
    const current = await read();
    firstStageRevision ??= saved.revision;
    expect(saved.revision).toBe(before.revision + 1);
    expect(current).toMatchObject({ dirty: false, revision: saved.revision, savedRevision: saved.revision });
    expect(topology(diagramXml(readFileSync(bridge.filename, 'utf8')))).toBe(topology(current.xml));
    expect(geometry(current.xml, 'function')).toBe(geometry(initial.xml, 'function'));
    for (const operation of operations) await expect(page.frameLocator('#editor').getByText(operation.label, { exact: true }).filter({ visible: true }).first()).toBeVisible();
  }
  const completed = await read();
  const savedSvg = readFileSync(bridge.filename, 'utf8');
  expect(savedSvg).toContain('data:image/svg+xml');
  await expect(invoke('apply_operations', { expectedRevision: firstStageRevision!, pageId, operations: [{ kind: 'update', id: 'stage-content', label: 'Stale change' }] })).rejects.toMatchObject({ code: 'drawio_conflict' });
  expect(readFileSync(bridge.filename, 'utf8')).toBe(savedSvg);
  await page.route('**/api/commit', route => route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'Later stage rejected in test' }) }));
  await expect(invoke('apply_operations', { expectedRevision: completed.revision, pageId, operations: [{ kind: 'update', id: 'stage-content', label: 'Uncommitted change' }] })).rejects.toMatchObject({ code: 'drawio_update_failed' });
  await page.unroute('**/api/commit');
  const afterFailure = await read();
  expect(afterFailure).toMatchObject({ dirty: false, revision: completed.revision, savedRevision: completed.revision });
  expect(topology(afterFailure.xml)).toBe(topology(completed.xml));
  expect(geometry(afterFailure.xml, 'stage-boundary')).toBe(geometry(completed.xml, 'stage-boundary'));
  expect(geometry(afterFailure.xml, 'stage-resource')).toBe(geometry(completed.xml, 'stage-resource'));
  expect(readFileSync(bridge.filename, 'utf8')).toBe(savedSvg);
  localUrls.push((await bridge.restart()).url);
  await page.goto((await options.open({ ...panel, input: undefined })).url);
  await expect(page.locator('#status')).toContainText('Saved', { timeout: 30_000 });
  await expect(page.frameLocator('#editor').getByText('Local icon', { exact: true }).filter({ visible: true }).first()).toBeVisible();
  await expect(page.frameLocator('#editor').getByText('Service calls', { exact: true }).filter({ visible: true }).first()).toBeVisible();
  expect(readFileSync(bridge.filename, 'utf8')).toBe(savedSvg);
  expect(external).toEqual([]);
});

function externalEdit(svg: string) {
  const document = parse(svg);
  document.documentElement.setAttribute('content', applyOperations(diagramXml(svg), [
    { kind: 'update', id: 'function', label: 'Desktop-edited Function App', geometry: { x: 150, y: 110, width: 66, height: 66 } },
  ], true));
  return document.toString();
}

test('desktop handoff pauses saving, rejects unsafe external edits and resumes the same file', async ({ page, request, bridge }) => {
  await page.route('**/api/open-desktop', route => route.fulfill({ json: { opened: true } }));
  await page.goto(bridge.url);
  await expect(page.locator('#open-drawio')).toBeEnabled({ timeout: 30_000 });
  await page.locator('#open-drawio').click();
  await expect(page.locator('#status')).toContainText('Opened in draw.io desktop');
  await expect(page.locator('#save')).toBeDisabled();
  await expect(page.locator('#resume')).toBeEnabled();
  expect(await page.locator('#editor').evaluate(frame => frame.inert)).toBe(true);
  const headers = { Authorization: `Bearer ${bridge.token}` };
  const read = async () => (await request.get(bridge.url + '/api/document', { headers })).json();
  const initial = await read();
  expect(initial.paused).toBe(true);
  expect(existsSync(bridge.filename + '.handoff')).toBe(true);
  const saved = readFileSync(bridge.filename, 'utf8');
  const editorId = await page.evaluate(() => sessionStorage.bridgeEditorId);
  expect((await request.post(bridge.url + '/api/save', { headers, data: { editorId, expectedRevision: initial.revision, svg: saved } })).status()).toBe(409);
  expect((await request.post(bridge.url + '/api/operations', { headers, data: { expectedRevision: initial.revision, operations: [] } })).status()).toBe(409);
  expect((await request.post(bridge.url + '/api/open-desktop', { data: { editorId } })).status()).toBe(401);
  expect((await request.post(bridge.url + '/api/open-desktop', { headers, data: { editorId } })).status()).toBe(403);
  await page.frameLocator('#editor').locator('body').evaluate(() => parent.postMessage(JSON.stringify({ event: 'autosave', xml: '<mxfile/>' }), location.origin));
  await page.waitForTimeout(1000);
  expect(readFileSync(bridge.filename, 'utf8')).toBe(saved);
  const invalid = saved.replace('</svg>', '<script>throw new Error("invalid external SVG")</script></svg>');
  writeFileSync(bridge.filename, invalid);
  const rejected = page.waitForResponse(response => response.url().endsWith('/api/editor'));
  await page.locator('#resume').click();
  expect((await rejected).status()).toBe(400);
  await expect(page.locator('#status')).toHaveClass('error');
  expect((await read()).paused).toBe(true);
  expect(readFileSync(bridge.filename, 'utf8')).toBe(invalid);
  const external = externalEdit(saved);
  writeFileSync(bridge.filename, external);
  await page.locator('#resume').click();
  await expect(page.locator('#status')).toContainText('Saved', { timeout: 30_000 });
  await expect(page.frameLocator('#editor').getByText('Desktop-edited Function App', { exact: true })).toBeVisible();
  const resumed = await read();
  expect(resumed).toMatchObject({ paused: false, dirty: false, revision: initial.revision + 1 });
  expect(geometry(resumed.xml, 'function')).toBe(geometry(diagramXml(external), 'function'));
  expect(readFileSync(bridge.filename, 'utf8')).toBe(external);
  expect(existsSync(bridge.filename + '.handoff')).toBe(false);
  await expect(page.locator('#resume')).toBeHidden();
});

test('desktop pause survives bridge restart without reopening a competing editor', async ({ page, request, bridge }) => {
  await page.route('**/api/open-desktop', route => route.fulfill({ json: { opened: true } }));
  await page.goto(bridge.url);
  await expect(page.locator('#open-drawio')).toBeEnabled({ timeout: 30_000 });
  await page.locator('#open-drawio').click();
  await expect(page.locator('#status')).toContainText('Opened in draw.io desktop');
  const external = externalEdit(readFileSync(bridge.filename, 'utf8'));
  writeFileSync(bridge.filename, external);
  const restarted = await bridge.restart();
  await page.goto(restarted.url);
  await expect(page.locator('#resume')).toBeEnabled();
  expect(await page.locator('#editor').getAttribute('src')).toBe(null);
  expect((await (await request.get(restarted.url + '/api/document', { headers: { Authorization: `Bearer ${restarted.token}` } })).json()).paused).toBe(true);
  await page.locator('#resume').click();
  await expect(page.locator('#status')).toContainText('Saved', { timeout: 30_000 });
  await expect(page.frameLocator('#editor').getByText('Desktop-edited Function App', { exact: true })).toBeVisible();
  expect(readFileSync(bridge.filename, 'utf8')).toBe(external);
});

test('browser fallback transfers a single lease and preview is a read-only button', async ({ page, context, request, bridge }) => {
  await page.route('**/api/open-desktop', route => route.fulfill({ json: { opened: false } }));
  await page.goto(bridge.url);
  await expect(page.locator('#open-drawio')).toBeEnabled({ timeout: 30_000 });
  const browserOpened = context.waitForEvent('page');
  await page.locator('#open-drawio').click();
  const browser = await browserOpened;
  await expect(browser.locator('#status')).toContainText('Saved', { timeout: 30_000 });
  expect(browser.url()).toBe(bridge.url + '/');
  expect(await browser.evaluate(() => sessionStorage.bridgeEditorId)).not.toBe(await page.evaluate(() => sessionStorage.bridgeEditorId));
  await expect(page.locator('#save')).toBeDisabled();
  await page.locator('#resume').click();
  await expect(page.locator('#status')).toContainText('open in another editor');
  await expect(page.locator('#save')).toBeDisabled();
  const headers = { Authorization: `Bearer ${bridge.token}` };
  const read = async () => (await request.get(bridge.url + '/api/document', { headers })).json();
  const initial = await read();
  await dragFunction(browser);
  await expect.poll(async () => geometry((await read()).xml, 'function')).not.toBe(geometry(initial.xml, 'function'));
  await expect.poll(async () => !(await read()).dirty).toBeTruthy();
  const edited = await read();
  const saved = readFileSync(bridge.filename, 'utf8');
  expect(await browser.locator('#preview').evaluate(element => element.tagName)).toBe('BUTTON');
  const previewOpened = context.waitForEvent('page');
  await browser.locator('#preview').click();
  const preview = await previewOpened;
  await preview.waitForLoadState();
  expect(preview.url()).toBe(bridge.url + '/diagram.svg');
  expect(readFileSync(bridge.filename, 'utf8')).toBe(saved);
  await preview.close();
  await Promise.all([browser.waitForEvent('close'), browser.close({ runBeforeUnload: true })]);
  await expect.poll(async () => {
    const response = page.waitForResponse(response => response.url().endsWith('/api/editor'));
    await page.locator('#resume').click();
    return (await response).status();
  }, { timeout: 3000, intervals: [100] }).toBe(200);
  await expect(page.locator('#status')).toContainText('Saved', { timeout: 30_000 });
  expect(geometry((await read()).xml, 'function')).toBe(geometry(edited.xml, 'function'));
  expect(readFileSync(bridge.filename, 'utf8')).toBe(saved);
});

test('editor close releases only its current lease and never changes the saved drawing', async ({ request, bridge }) => {
  const headers = { Authorization: `Bearer ${bridge.token}` };
  const post = (path: string, data: object) => request.post(bridge.url + '/api/' + path, { headers, data });
  const saved = readFileSync(bridge.filename, 'utf8');
  const first = await (await post('editor', { editorId: 'original' })).json();
  const closing = { editorId: 'original', editorLease: first.editorLease };
  expect((await request.post(bridge.url + '/api/editor/release', { data: closing })).status()).toBe(401);
  expect((await request.post(bridge.url + '/api/editor/release', { headers: { ...headers, Origin: 'https://example.com' }, data: closing })).status()).toBe(403);
  for (const invalid of [{ editorId: 'other', editorLease: first.editorLease }, { editorId: 'original' }, { editorId: 'original', editorLease: 'wrong' }]) {
    expect(await (await post('editor/release', invalid)).json()).toEqual({ released: false });
  }
  expect((await post('editor', { editorId: 'replacement' })).status()).toBe(409);
  const refreshed = await (await post('editor', { editorId: 'original' })).json();
  expect(refreshed.editorLease).not.toBe(first.editorLease);
  expect(await (await post('editor/release', closing)).json()).toEqual({ released: false });
  expect((await post('editor', { editorId: 'replacement' })).status()).toBe(409);
  expect(await (await post('editor/release', { editorId: 'original', editorLease: refreshed.editorLease })).json()).toEqual({ released: true });
  expect(await (await post('editor/release', { editorId: 'original', editorLease: refreshed.editorLease })).json()).toEqual({ released: false });
  expect((await post('editor', { editorId: 'replacement' })).status()).toBe(200);
  expect(await (await post('editor/release', closing)).json()).toEqual({ released: false });
  expect((await post('editor', { editorId: 'original' })).status()).toBe(409);
  expect(readFileSync(bridge.filename, 'utf8')).toBe(saved);
});

test('a crashed editor still expires when no close notification or heartbeat arrives', async ({ request, bridge }) => {
  const headers = { Authorization: `Bearer ${bridge.token}` };
  const claim = (editorId: string) => request.post(bridge.url + '/api/editor', { headers, data: { editorId } });
  const saved = readFileSync(bridge.filename, 'utf8');
  expect((await claim('crashed')).status()).toBe(200);
  expect((await claim('replacement')).status()).toBe(409);
  await expect.poll(async () => (await claim('replacement')).status(), { timeout: 18_000, intervals: [1000] }).toBe(200);
  expect(readFileSync(bridge.filename, 'utf8')).toBe(saved);
});

test('handoff rejects stale revisions, unsaved drafts and pending operations without changing the SVG', async ({ request, bridge }) => {
  const headers = { Authorization: `Bearer ${bridge.token}` };
  const post = (path: string, data: object) => request.post(bridge.url + '/api/' + path, { headers, data: { ...data, editorId: 'handoff-test' } });
  const initial = await (await post('editor', {})).json();
  const saved = readFileSync(bridge.filename, 'utf8');
  expect((await post('handoff', { expectedRevision: initial.revision - 1 })).status()).toBe(409);
  expect((await post('operations', { expectedRevision: initial.revision, operations: [{ kind: 'update', id: 'function', label: 'Pending edit' }] })).status()).toBe(202);
  expect((await post('handoff', { expectedRevision: initial.revision })).status()).toBe(409);
  const draft = await (await post('draft', { expectedRevision: initial.revision, xml: applyOperations(initial.xml, [{ kind: 'update', id: 'function', label: 'Unsaved draft' }]) })).json();
  expect(draft.dirty).toBe(true);
  expect((await post('handoff', { expectedRevision: draft.revision })).status()).toBe(409);
  expect(existsSync(bridge.filename + '.handoff')).toBe(false);
  expect(readFileSync(bridge.filename, 'utf8')).toBe(saved);
});
