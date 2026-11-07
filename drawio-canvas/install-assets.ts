import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createWriteStream, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { buildShapeIndex } from '../diagram-bridge/shapes';

// GitHub's published digest for jgraph/drawio v32.6.9, asset draw.war.
export const release = {
  url: 'https://github.com/jgraph/drawio/releases/download/v32.6.9/draw.war',
  sha256: '31afc82b7920c409d0591f6126ccb6c377d7800e7f11ab324f88bdf1e4249ce7',
  size: 49_701_599,
};

export function validateAssets(directory: string) {
  const file = (path: string) => {
    const full = join(directory, path);
    if (!lstatSync(full).isFile() || !lstatSync(full).size) throw new Error(`Missing or empty asset: ${path}`);
    return readFileSync(full, 'utf8');
  };
  const walk = (path: string) => {
    if (!lstatSync(path).isDirectory()) throw new Error(`Expected asset directory: ${path}`);
    const entries = readdirSync(path, { withFileTypes: true });
    if (!entries.length) throw new Error(`Empty asset directory: ${path}`);
    for (const entry of entries) {
      if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) throw new Error(`Unsupported asset: ${entry.name}`);
      if (entry.isDirectory()) walk(join(path, entry.name));
    }
  };
  walk(directory);
  for (const path of ['js/app.min.js', 'js/main.js', 'js/bootstrap.js', 'js/grapheditor/Sidebar.js', 'styles/grapheditor.css', 'styles/high-contrast.css', 'mxgraph/mxClient.js']) file(path);
  for (const path of ['img/lib', 'images', 'resources', 'stencils', 'shapes', 'templates']) walk(join(directory, path));
  const index = file('index.html');
  for (const match of index.matchAll(/(?:src|href)=["']([^"']+)["']/g)) {
    if (!/^(?:https?:|data:|#|\/\/)/.test(match[1])) file(match[1].split(/[?#]/)[0]);
  }
  buildShapeIndex(directory);
}

function command(executable: string, args: string[], env = process.env) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(executable, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, env });
    let error = '';
    child.stderr.on('data', data => { error = (error + data).slice(-4000); });
    child.once('error', cause => reject(new Error(`${executable} is required for asset extraction: ${cause.message}`)));
    child.once('close', code => code === 0 ? resolve() : reject(new Error(`${executable} extraction failed (${code}): ${error}`)));
  });
}

export async function fetchArchive(archive: string, pinned = release) {
  const response = await fetch(pinned.url, { signal: AbortSignal.timeout(600_000) });
  if (!response.ok || !response.body) throw new Error(`Pinned draw.io download failed (HTTP ${response.status}).`);
  let received = 0;
  const limit = new Transform({ transform(chunk, _encoding, callback) {
    received += chunk.length;
    callback(received > pinned.size ? new Error('Draw.io download exceeds pinned archive size.') : null, chunk);
  } });
  await pipeline(Readable.fromWeb(response.body as any), limit, createWriteStream(archive, { flags: 'wx', mode: 0o600 }));
}

// Reject unsafe paths and symlinks before any OS extractor can write them.
export function validateArchive(data: Buffer) {
  let end = data.length - 22;
  while (end >= Math.max(0, data.length - 65_557) && data.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0 || end < data.length - 65_557 || data.readUInt32LE(end) !== 0x06054b50) throw new Error('Incomplete ZIP archive.');
  if (end + 22 + data.readUInt16LE(end + 20) !== data.length || data.readUInt16LE(end + 4) || data.readUInt16LE(end + 6)) throw new Error('Unsupported ZIP archive.');
  const count = data.readUInt16LE(end + 10);
  const size = data.readUInt32LE(end + 12);
  let offset = data.readUInt32LE(end + 16);
  const finish = offset + size;
  if (!count || count === 0xffff || finish !== end || data.readUInt16LE(end + 8) !== count) throw new Error('Incomplete ZIP directory.');
  const names = new Set<string>();
  const entries: { name: string; size: number }[] = [];
  for (let i = 0; i < count; i++) {
    if (offset + 46 > finish || data.readUInt32LE(offset) !== 0x02014b50) throw new Error('Incomplete ZIP entry.');
    const length = data.readUInt16LE(offset + 28);
    const next = offset + 46 + length + data.readUInt16LE(offset + 30) + data.readUInt16LE(offset + 32);
    if (next > finish) throw new Error('Incomplete ZIP entry.');
    const name = data.subarray(offset + 46, offset + 46 + length).toString('utf8');
    const mode = data.readUInt32LE(offset + 38) >>> 16;
    const parts = name.replace(/\/$/, '').split('/');
    if (!name || name.startsWith('/') || /[\\:<>"|?*\x00-\x1f]/.test(name) || parts.some(part => !part || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) || names.has(name.toLowerCase()) || (mode & 0xf000) === 0xa000 || data.readUInt16LE(offset + 8) & 1) throw new Error('Unsafe draw.io archive path or entry.');
    names.add(name.toLowerCase());
    entries.push({ name, size: data.readUInt32LE(offset + 24) });
    offset = next;
  }
  if (offset !== finish) throw new Error('Incomplete ZIP directory.');
  return entries;
}

export async function extractArchive(archive: string, destination: string, { platform = process.platform, execute = command } = {}) {
  if (platform === 'win32') {
    await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::ExtractToDirectory($env:DRAWIO_ARCHIVE, $env:DRAWIO_OUTPUT)'], { ...process.env, DRAWIO_ARCHIVE: archive, DRAWIO_OUTPUT: destination });
  } else {
    await execute('unzip', ['-tq', archive]);
    await execute('unzip', ['-q', archive, '-d', destination]);
  }
}

export async function downloadAssets(work: string, { pinned = release, download = fetchArchive, extract = extractArchive } = {}) {
  const archive = join(work, 'draw.zip');
  await download(archive, pinned);
  const data = readFileSync(archive);
  if (data.length !== pinned.size || createHash('sha256').update(data).digest('hex') !== pinned.sha256) throw new Error('Pinned draw.io archive size/SHA-256 mismatch.');
  const entries = validateArchive(data);
  const assets = join(work, 'downloaded-assets');
  await extract(archive, assets);
  for (const entry of entries) {
    const stat = lstatSync(join(assets, entry.name));
    if (entry.name.endsWith('/') ? !stat.isDirectory() : !stat.isFile() || stat.size !== entry.size) throw new Error(`Incomplete extracted asset: ${entry.name}`);
  }
  validateAssets(assets);
  return assets;
}

export function assertDirectories(path: string) {
  for (let current = resolve(path); ; current = dirname(current)) {
    if (existsSync(current) && (!lstatSync(current).isDirectory() || lstatSync(current).isSymbolicLink())) throw new Error(`Unsafe installation directory: ${current}`);
    if (current === dirname(current)) return;
  }
}

export async function ensureAssets({
  destination,
  assets,
  candidates = [],
  acquire = downloadAssets,
  move = renameSync,
  lockTimeoutMs = 650_000,
}: {
  destination: string;
  assets?: string;
  candidates?: string[];
  acquire?: typeof downloadAssets;
  move?: typeof renameSync;
  lockTimeoutMs?: number;
}) {
  if (assets !== undefined) {
    try { validateAssets(resolve(assets)); return resolve(assets); }
    catch { throw new Error('Explicit DRAWIO_ASSETS is incomplete or incompatible with pinned draw.io 32.6.9; no replacement downloaded.'); }
  }
  destination = resolve(destination);
  try { validateAssets(destination); return destination; } catch { /* Preparation may replace only implicit assets. */ }
  const parent = dirname(destination);
  assertDirectories(parent);
  mkdirSync(parent, { recursive: true });
  const lock = destination + '.prepare.lock';
  const deadline = Date.now() + lockTimeoutMs;
  for (;;) {
    try { mkdirSync(lock); break; }
    catch (error: any) {
      if (error.code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) throw new Error(`Asset preparation is busy or interrupted. Inspect ${lock} before retrying.`);
      await delay(100);
    }
  }
  let work: string | undefined;
  let retain = false;
  try {
    try { validateAssets(destination); return destination; } catch { /* Another process may have completed while we waited. */ }
    work = mkdtempSync(join(parent, '.drawio-assets-'));
    let selected: string | undefined;
    for (const candidate of candidates) {
      try { validateAssets(candidate); selected = candidate; break; } catch { /* Ignore only implicit candidates. */ }
    }
    const prepared = join(work, 'ready');
    if (selected) cpSync(selected, prepared, { recursive: true });
    else cpSync(await acquire(work), prepared, { recursive: true });
    validateAssets(prepared);
    const backup = join(work, 'previous');
    let old = false;
    try {
      if (existsSync(destination)) { move(destination, backup); old = true; }
      move(prepared, destination);
    } catch (error) {
      if (old) {
        try { renameSync(backup, destination); }
        catch { retain = true; throw new Error(`Asset rollback failed; recovery files retained at ${work}.`); }
      }
      throw error;
    }
    return destination;
  } catch (error: any) {
    throw new Error(`Draw.io assets could not be prepared. ${error.message}`);
  } finally {
    if (!retain) {
      if (work) rmSync(work, { recursive: true, force: true });
      rmSync(lock, { recursive: true, force: true });
    }
  }
}
