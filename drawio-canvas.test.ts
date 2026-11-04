import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canvasOptions } from './drawio-canvas/canvas.mjs';

class CanvasError extends Error {
  constructor(public code: string, message: string) { super(message); }
}
let temp: string;
let runtimeFile: string;
let token: string;
let server: ReturnType<typeof Bun.serve>;
let filename: string;
let state: any;
let input: any;
let operationRequests: number;
let fail = false;
let redirect = false;
let jobFailure = false;
const id = '123456789012345678901234';

beforeEach(() => {
  temp = mkdtempSync(join(tmpdir(), 'drawio-canvas-test-'));
  runtimeFile = join(temp, 'runtime.json');
  filename = join(temp, 'architecture.drawio.svg');
  token = 'a'.repeat(64);
  state = { filename, revision: 3, savedRevision: 3, dirty: false, xml: '<mxfile/>' };
  operationRequests = 0;
  fail = redirect = jobFailure = false;
  server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    if (request.headers.get('authorization') !== `Bearer ${token}`) return Response.json({ error: 'Authentication required' }, { status: 401 });
    if (redirect) return new Response(null, { status: 302, headers: { Location: 'https://example.com/' } });
    if (fail) return Response.json({ error: `failure with ${token}` }, { status: 400 });
    const path = new URL(request.url).pathname;
    if (path === '/api/document') return Response.json(state);
    if (path === '/api/operations') {
      operationRequests++;
      return request.json().then(body => {
        input = body;
        if (input.expectedRevision !== state.revision) return Response.json({ error: 'Diagram changed; read again' }, { status: 409 });
        return Response.json({ id }, { status: 202 });
      });
    }
    if (path === `/api/jobs/${id}`) {
      if (jobFailure) return Response.json({ status: 'failed', error: `Save failed ${token}` });
      state.revision++;
      state.savedRevision = state.revision;
      return Response.json({ status: 'completed', result: { filename, revision: state.revision } });
    }
    return Response.json({ error: 'Not found' }, { status: 404 });
  } });
  writeFileSync(runtimeFile, JSON.stringify({ url: `http://127.0.0.1:${server.port}`, token, filename }), { mode: 0o600 });
});
afterEach(async () => { await server.stop(true); rmSync(temp, { recursive: true, force: true }); });

const ctx = (input?: any, instanceId = 'panel-1') => ({ input, instanceId });
const action = (options: any, name: string) => options.actions.find((item: any) => item.name === name).handler;
const optionsForTest = () => canvasOptions(CanvasError, { preferencesDir: join(temp, 'preferences') });
const open = async () => { const options = optionsForTest(); await options.open(ctx({ runtimeFile })); return options; };

test('opens the existing editor and returns document state without runtime credentials', async () => {
  const options = optionsForTest();
  const result = await options.open(ctx({ runtimeFile }));
  expect(result.url).toBe(`http://127.0.0.1:${server.port}/`);
  expect(JSON.stringify(result)).not.toContain(token);
  const document = await action(options, 'read_document')(ctx({}));
  expect(document).toEqual(state);
  expect(JSON.stringify(document)).not.toContain(token);
});

test('rejects remote runtime URLs before forwarding authentication', async () => {
  writeFileSync(runtimeFile, JSON.stringify({ url: 'https://example.com/', token, filename }));
  await expect(optionsForTest().open(ctx({ runtimeFile }))).rejects.toMatchObject({ code: 'drawio_runtime_invalid' });
});

test('rejects relative, missing and oversized runtime files', async () => {
  const options = optionsForTest();
  await expect(options.open(ctx({ runtimeFile: 'runtime.json' }))).rejects.toMatchObject({ code: 'drawio_runtime_invalid' });
  await expect(options.open(ctx({ runtimeFile: join(temp, 'missing.json') }))).rejects.toMatchObject({ code: 'drawio_runtime_invalid' });
  writeFileSync(runtimeFile, ' '.repeat(4097));
  await expect(options.open(ctx({ runtimeFile }))).rejects.toMatchObject({ code: 'drawio_runtime_invalid' });
});

test('rehydrates the same document under fresh provider and panel identities', async () => {
  await open();
  const options = optionsForTest();
  await options.open(ctx(undefined, 'fresh-panel'));
  expect(await action(options, 'read_document')(ctx({}, 'fresh-panel'))).toEqual(state);
});

test('supports omitted, empty and null input across panels and provider restarts', async () => {
  const options = await open();
  const expected = { url: `http://127.0.0.1:${server.port}/`, title: 'architecture.drawio.svg', status: 'ready' };
  for (const input of [undefined, {}, null]) {
    expect(await options.open(ctx(input))).toEqual(expected);
    expect(await options.open(ctx(input, 'fresh-panel'))).toEqual(expected);
    expect(await optionsForTest().open(ctx(input, 'restarted-provider'))).toEqual(expected);
  }
  expect(options.inputSchema.required).toBeUndefined();
  expect(options.inputSchema.type).toEqual(['object', 'null']);
  expect(operationRequests).toBe(0);
  expect(state.revision).toBe(3);
});

test('persists only path and diagram identity with private file permissions', async () => {
  await open();
  const file = join(temp, 'preferences', 'last-bridge.json');
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ runtimeFile, filename });
  expect(readFileSync(file, 'utf8')).not.toContain(token);
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(statSync(join(temp, 'preferences')).mode & 0o777).toBe(0o700);
});

test('reports missing configuration without contacting or modifying the drawing', async () => {
  for (const input of [undefined, {}, null]) {
    await expect(optionsForTest().open(ctx(input))).rejects.toMatchObject({ code: 'drawio_not_configured' });
  }
  expect(existsSync(join(temp, 'preferences'))).toBe(false);
  expect(operationRequests).toBe(0);
  expect(state.revision).toBe(3);
});

test('refuses changed remembered identities but permits explicit selection', async () => {
  const options = await open();
  filename = join(temp, 'different.drawio.svg');
  state.filename = filename;
  writeFileSync(runtimeFile, JSON.stringify({ url: `http://127.0.0.1:${server.port}`, token, filename }));
  await expect(options.open(ctx())).rejects.toMatchObject({ code: 'drawio_document_changed' });
  await expect(optionsForTest().open(ctx())).rejects.toMatchObject({ code: 'drawio_document_changed' });
  await optionsForTest().open(ctx({ runtimeFile }));
  expect((await optionsForTest().open(ctx())).title).toBe('different.drawio.svg');
  expect(operationRequests).toBe(0);
});

test('failed selection does not replace the remembered document', async () => {
  await open();
  const file = join(temp, 'preferences', 'last-bridge.json');
  const before = readFileSync(file, 'utf8');
  await expect(optionsForTest().open(ctx({ runtimeFile: join(temp, 'missing.json') }))).rejects.toMatchObject({ code: 'drawio_runtime_invalid' });
  state.filename = join(temp, 'unexpected.drawio.svg');
  await expect(optionsForTest().open(ctx({ runtimeFile }))).rejects.toMatchObject({ code: 'drawio_document_changed' });
  expect(readFileSync(file, 'utf8')).toBe(before);
  expect(operationRequests).toBe(0);
});

test('missing runtime and invalid preferences require explicit repair', async () => {
  await open();
  rmSync(runtimeFile);
  await expect(optionsForTest().open(ctx())).rejects.toMatchObject({ code: 'drawio_runtime_invalid' });
  const file = join(temp, 'preferences', 'last-bridge.json');
  for (const content of ['not json', JSON.stringify({ runtimeFile: 'relative', filename }), ' '.repeat(4097)]) {
    writeFileSync(file, content);
    await expect(optionsForTest().open(ctx())).rejects.toMatchObject({ code: 'drawio_preferences_invalid' });
  }
  expect(operationRequests).toBe(0);
});

test('rehydration reloads runtime credentials and port rather than persisting them', async () => {
  await open();
  token = 'b'.repeat(64);
  writeFileSync(runtimeFile, JSON.stringify({ url: `http://127.0.0.1:${server.port}`, token, filename }));
  const options = optionsForTest();
  await options.open(ctx());
  expect(await action(options, 'read_document')(ctx({}))).toEqual(state);
  expect(readFileSync(join(temp, 'preferences', 'last-bridge.json'), 'utf8')).not.toContain(token);
});

test('closing then opening without input preserves the remembered selection', async () => {
  const options = await open();
  options.onClose(ctx());
  await options.open(ctx());
  expect(await action(options, 'read_document')(ctx({}))).toEqual(state);
});

test('waits for save confirmation and forwards explicit revisions and layout permission', async () => {
  const options = await open();
  const operations = [{ kind: 'update', id: 'function', label: 'Updated' }];
  const result = await action(options, 'apply_operations')(ctx({ expectedRevision: 3, operations }));
  expect(result).toEqual({ filename, revision: 4 });
  expect(input).toEqual({ expectedRevision: 3, operations });
  expect(operationRequests).toBe(1);
  await action(options, 'apply_operations')(ctx({ expectedRevision: 4, operations, relayout: true }));
  expect(input.relayout).toBe(true);
});

test('reports revision conflicts without blindly retrying', async () => {
  const options = await open();
  await expect(action(options, 'apply_operations')(ctx({ expectedRevision: 0, operations: [] }))).rejects.toMatchObject({ code: 'drawio_conflict' });
  expect(operationRequests).toBe(1);
});

test('redacts bridge credentials from failed requests and failed saves', async () => {
  const options = await open();
  fail = true;
  await expect(action(options, 'read_document')(ctx({}))).rejects.toMatchObject({ code: 'drawio_request_failed', message: 'failure with [redacted]' });
  fail = false;
  jobFailure = true;
  await expect(action(options, 'apply_operations')(ctx({ expectedRevision: 3, operations: [] }))).rejects.toMatchObject({ code: 'drawio_update_failed', message: 'Save failed [redacted]' });
});

test('refuses redirects and refuses silently switching documents', async () => {
  const options = await open();
  redirect = true;
  await expect(action(options, 'read_document')(ctx({}))).rejects.toMatchObject({ code: 'drawio_bridge_unavailable' });
  redirect = false;
  writeFileSync(runtimeFile, JSON.stringify({ url: `http://127.0.0.1:${server.port}`, token, filename: join(temp, 'different.drawio.svg') }));
  await expect(action(options, 'read_document')(ctx({}))).rejects.toMatchObject({ code: 'drawio_document_changed' });
});

test('closing removes only the panel binding, not the document or bridge', async () => {
  const options = await open();
  options.onClose(ctx());
  await expect(action(options, 'read_document')(ctx({}))).rejects.toMatchObject({ code: 'drawio_not_open' });
  await options.open(ctx({ runtimeFile }));
  expect(await action(options, 'read_document')(ctx({}))).toEqual(state);
});
