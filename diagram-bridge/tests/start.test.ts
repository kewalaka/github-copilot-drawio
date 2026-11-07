import { afterEach, beforeEach, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

let home: string;
beforeEach(() => { home = mkdtempSync(join(import.meta.dir, '../.install-test-')); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

function fixtureAssets(root: string) {
  const files = {
    'index.html': '<html></html>',
    'js/app.min.js': 'EditorUi.VERSION="32.6.9";',
    'js/grapheditor/Sidebar.js': "Sidebar.prototype.addGeneralPalette = function() {this.createVertexTemplateEntry('rounded=0;', 80, 80, '', 'Rectangle');this.addEntry('list group erd table'",
    'img/lib/example/icon.svg': '<svg viewBox="0 0 10 10"/>',
  };
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), content);
  }
}

async function runCli(entry: string, env: NodeJS.ProcessEnv, runtimeFile: string, filename: string) {
  const child = spawn('bun', ['run', entry], { cwd: home, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', data => { stdout += data; });
  child.stderr.on('data', data => { stderr += data; });
  const exited = new Promise<number | null>(resolve => { child.once('exit', code => resolve(code)); child.once('error', () => resolve(null)); });
  let url = '';
  try {
    url = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`CLI startup timed out: ${stderr}`)), 10_000);
      const finish = (value: string) => { clearTimeout(timer); resolve(value); };
      child.stdout.on('data', () => { const match = stdout.match(/^(http:\/\/127\.0\.0\.1:\d+)\n/); if (match) finish(match[1]); });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`CLI exited before startup (${code}): ${stderr}`)); });
    });
    const response = await fetch(url + '/health');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    const runtime = JSON.parse(readFileSync(runtimeFile, 'utf8'));
    expect(runtime.filename).toBe(filename);
    expect(runtime.url).toBe(url);
    expect(runtime.pid).toBe(child.pid);
    expect(stdout).toBe(url + '\n');
    expect(stdout).not.toContain(runtime.token);
    expect(stderr).toBe('');
  } finally {
    child.kill('SIGTERM');
    const force = setTimeout(() => child.kill('SIGKILL'), 2000);
    try { const code = await exited; if (url) expect(code).toBe(0); } finally { clearTimeout(force); }
  }
  await expect(fetch(url + '/health', { signal: AbortSignal.timeout(1000) })).rejects.toThrow();
}

test('development CLI starts a real isolated bridge using explicit paths and prints only its URL', async () => {
  const assets = join(home, 'assets'); fixtureAssets(assets);
  const filename = join(home, 'drawings/architecture.drawio.svg');
  const runtimeFile = join(home, 'private/runtime.json');
  await runCli(join(import.meta.dir, '../start.ts'), { ...process.env, DIAGRAM_FILE: filename, BRIDGE_RUNTIME: runtimeFile, DRAWIO_ASSETS: assets, PORT: '0' }, runtimeFile, filename);
}, 30_000);

for (const local of [true, false]) test(`development CLI defaults stay module-relative with ${local ? 'checkout' : 'adjacent'} assets`, async () => {
  const root = join(home, 'checkout'); mkdirSync(root);
  for (const file of ['start.ts', 'server.ts', 'model.ts', 'empty.ts', 'shapes.ts', 'desktop.ts']) cpSync(join(import.meta.dir, '..', file), join(root, file));
  fixtureAssets(local ? join(root, 'vendor/drawio') : join(home, 'artifacts/vendor/drawio'));
  const env = { ...process.env };
  for (const key of ['DIAGRAM_FILE', 'BRIDGE_RUNTIME', 'DRAWIO_ASSETS', 'PORT']) delete env[key];
  await runCli(join(root, 'start.ts'), env, join(root, 'runtime.json'), join(root, 'diagrams/architecture.drawio.svg'));
}, 30_000);
