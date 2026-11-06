import { test as base, expect, type Page } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diagramXml, parse, topology } from '../model';
import { canvasOptions } from '../../drawio-canvas/canvas.mjs';
import { seed } from '../seed';

type Runtime = { url: string; token: string; filename: string };
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
  const savedSvg = readFileSync(bridge.filename, 'utf8');
  await page.route('**/api/draft', route => route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'Rejected test draft' }) }));
  await dragFunction(page);
  await expect(page.locator('#status')).toContainText('Rejected test draft');
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
  expect(readFileSync(bridge.filename, 'utf8')).not.toBe(savedSvg);
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
  await expect(page.locator('#save')).toBeEnabled({ timeout: 30_000 });
  const firstSave = page.waitForResponse(response => response.url().endsWith('/api/save') && response.ok());
  await page.locator('#save').click();
  await firstSave;
  await expect(page.locator('#status')).toContainText('Saved');
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
