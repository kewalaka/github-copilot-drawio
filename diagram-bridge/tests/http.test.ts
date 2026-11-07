import { afterEach, beforeEach, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { request, type ClientRequest } from 'node:http';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

let directory: string;
let bridge: { url: string; close: () => Promise<void> };
let authorization: string;
beforeEach(async () => {
  directory = mkdtempSync(join(import.meta.dir, '../.http-test-'));
  const runtimeFile = join(directory, 'runtime.json');
  const bundle = join(directory, 'server.mjs');
  const build = await Bun.build({ entrypoints: [join(import.meta.dir, '../server.ts')], target: 'node', outdir: directory, naming: 'server.mjs' });
  if (!build.success) throw new Error(build.logs.join('\n'));
  const options = { filename: join(directory, 'drawing.drawio.svg'), runtimeFile, assets: directory };
  const child = spawn('node', ['--input-type=module', '-e', `import { startBridge } from ${JSON.stringify(pathToFileURL(bundle).href)}; const bridge = await startBridge(${JSON.stringify(options)}); console.log(bridge.url); process.on('SIGTERM', () => bridge.close().then(() => process.exit(0)));`], { stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
  bridge = { url: '', close: async () => {
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
    try { await exited; } finally { clearTimeout(timer); }
  } };
  bridge.url = await new Promise<string>((resolve, reject) => {
    let stdout = ''; let stderr = '';
    const timer = setTimeout(() => reject(new Error(`Node bridge startup timed out: ${stderr}`)), 5000);
    child.stderr.on('data', data => { stderr += data; });
    child.stdout.on('data', data => { stdout += data; if (stdout.includes('\n')) { clearTimeout(timer); resolve(stdout.trim()); } });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', () => { clearTimeout(timer); reject(new Error(`Node bridge exited: ${stderr}`)); });
  });
  authorization = `Bearer ${JSON.parse(readFileSync(runtimeFile, 'utf8')).token}`;
});
afterEach(async () => {
  await bridge?.close();
  rmSync(directory, { recursive: true, force: true });
});

function upload(headers: Record<string, string>, send: (req: ClientRequest) => void, path = '/api/editor') {
  return new Promise<{ status: number; body: unknown; ended: boolean; connection: string | undefined }>((resolve, reject) => {
    const req = request(bridge.url + path, { method: 'POST', headers, agent: false }, response => {
      const ended = req.writableEnded;
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => {
        clearTimeout(timer);
        const text = Buffer.concat(chunks).toString();
        if (!text) { reject(new Error(`Empty response body (status ${response.statusCode})`)); req.destroy(); return; }
        resolve({ status: response.statusCode!, body: JSON.parse(text), ended, connection: response.headers.connection });
        req.destroy();
      });
    });
    const timer = setTimeout(() => {
      reject(new Error('Response waited for upload completion'));
      req.destroy();
    }, 2000);
    req.on('error', error => { clearTimeout(timer); reject(error); });
    send(req);
  });
}

for (const chunked of [false, true]) {
  for (const denied of ['missing token', 'wrong token', 'foreign origin', 'invalid host'] as const) {
    test(`${denied} rejects an unfinished ${chunked ? 'chunked' : 'declared'} upload before buffering`, async () => {
      const headers: Record<string, string> = { authorization, 'content-type': 'application/json' };
      if (chunked) headers['transfer-encoding'] = 'chunked';
      else headers['content-length'] = '24000001';
      if (denied === 'missing token') delete headers.authorization;
      if (denied === 'wrong token') headers.authorization = 'Bearer invalid';
      if (denied === 'foreign origin') headers.origin = 'https://foreign.example';
      if (denied === 'invalid host') headers.host = 'foreign.example';
      const response = await upload(headers, req => { req.write('{'); });
      const invalidAuthentication = denied === 'missing token' || denied === 'wrong token';
      expect(response.status).toBe(invalidAuthentication ? 401 : 403);
      expect(response.body).toEqual({ error: invalidAuthentication ? 'Authentication required' : denied === 'foreign origin' ? 'Invalid origin' : 'Invalid host' });
      expect(response.ended).toBe(false);
      expect(response.connection).toBe('close');
      expect((await fetch(bridge.url + '/health')).status).toBe(200);
    });
  }
}

test('authenticated declared and chunked uploads retain the 24 MB cap', async () => {
  const declared = await upload({ authorization, 'content-length': '24000001' }, req => { req.write('{'); });
  expect(declared.status).toBe(413);
  expect(declared.ended).toBe(false);
  const chunked = await new Promise<string>((resolve, reject) => {
    const url = new URL(bridge.url);
    const socket = createConnection({ host: url.hostname, port: Number(url.port) });
    let response = '';
    const timer = setTimeout(() => { reject(new Error('Chunked body cap did not respond')); socket.destroy(); }, 2000);
    socket.on('connect', () => {
      socket.write(`POST /api/editor HTTP/1.1\r\nHost: ${url.host}\r\nAuthorization: ${authorization}\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n${(24_000_001).toString(16)}\r\n`);
      socket.write(Buffer.alloc(24_000_001, 32));
      socket.write('\r\n0\r\n\r\n');
    });
    socket.on('data', data => { response += data.toString(); });
    socket.on('error', error => { clearTimeout(timer); reject(error); });
    socket.on('end', () => { clearTimeout(timer); resolve(response); socket.destroy(); });
  });
  expect(chunked).toStartWith('HTTP/1.1 413');
  expect(chunked).toContain(JSON.stringify({ error: 'Request body exceeds 24 MB' }));
  expect((await fetch(bridge.url + '/health')).status).toBe(200);
});

test('authenticated JSON and bodyless requests preserve editor and document behavior', async () => {
  expect((await fetch(bridge.url + '/health')).status).toBe(200);
  expect((await fetch(bridge.url + '/health', { method: 'HEAD' })).status).toBe(405);
  expect((await fetch(bridge.url + '/api/document')).status).toBe(401);
  const headers = { authorization, origin: bridge.url, 'content-type': 'application/json' };
  const editorResponse = await fetch(bridge.url + '/api/editor', { method: 'POST', headers, body: JSON.stringify({ editorId: 'http-test' }) });
  expect(editorResponse.status).toBe(200);
  const editor = await editorResponse.json();
  expect(typeof editor.editorLease).toBe('string');
  expect((await fetch(bridge.url + '/api/document', { headers })).status).toBe(200);
  const released = await fetch(bridge.url + '/api/editor/release', { method: 'POST', headers, body: JSON.stringify({ editorId: 'http-test', editorLease: editor.editorLease }) });
  expect(await released.json()).toEqual({ released: true });
});

test('aborted authenticated and rejected uploads do not break subsequent requests', async () => {
  for (const auth of [authorization, 'Bearer invalid']) {
    await new Promise<void>((resolve, reject) => {
      const url = new URL(bridge.url);
      const socket = createConnection({ host: url.hostname, port: Number(url.port) });
      const timer = setTimeout(() => { socket.destroy(); reject(new Error('Upload did not connect')); }, 2000);
      socket.on('error', () => {});
      socket.on('close', () => { clearTimeout(timer); resolve(); });
      socket.on('connect', () => {
        socket.write(`POST /api/editor HTTP/1.1\r\nHost: ${url.host}\r\nAuthorization: ${auth}\r\nTransfer-Encoding: chunked\r\n\r\n1\r\n{\r\n`);
        setTimeout(() => socket.destroy(), 20);
      });
    });
    expect((await fetch(bridge.url + '/health')).status).toBe(200);
  }
});
