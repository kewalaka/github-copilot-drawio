import { test as base, expect, type Page } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diagramXml, parse, topology } from '../model';
import { canvasOptions } from '../../drawio-canvas/canvas.mjs';

type Runtime = { url: string; token: string; filename: string };
const test = base.extend<{ bridge: Runtime & { restart: () => Promise<Runtime>; runtimePath: string; temp: string } }>({
  bridge: async ({}, use) => {
    const temp = mkdtempSync(join(tmpdir(), 'diagram-bridge-test-'));
    const runtimePath = join(temp, 'runtime.json');
    let child: ReturnType<typeof spawn>;
    async function stop() {
      if (!child || child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
      child.kill('SIGTERM');
      await exited;
    }
    async function start(): Promise<Runtime> {
      rmSync(runtimePath, { force: true });
      child = spawn('bun', ['run', 'server.ts'], {
        cwd: import.meta.dirname + '/..', env: { ...process.env, DIAGRAM_FILE: join(temp, 'test.drawio.svg'), BRIDGE_RUNTIME: runtimePath, PORT: '0' },
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
  const options = canvasOptions(CanvasError, { preferencesDir: join(bridge.temp, 'preferences') });
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
  const rehydrated = canvasOptions(CanvasError, { preferencesDir: join(bridge.temp, 'preferences') });
  const freshPanel = { instanceId: 'new-panel', input: undefined };
  await page.goto((await rehydrated.open(freshPanel)).url);
  await expect(page.locator('#status')).toContainText('Saved', { timeout: 30_000 });
  await expect(page.frameLocator('#editor').getByText(operation.label, { exact: true })).toBeVisible();
  expect(readFileSync(bridge.filename, 'utf8')).toBe(savedSvg);
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
  await page.unroute('**/api/commit');
  await page.locator('#save').click();
  await expect(page.locator('#status')).toContainText('Saved');
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
