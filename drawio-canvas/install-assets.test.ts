import { afterEach, beforeEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { downloadAssets, ensureAssets, extractArchive, fetchArchive, release, validateArchive, validateAssets } from './install-assets';

let home: string;
let assets: string;
let destination: string;
beforeEach(() => {
  home = mkdtempSync(join(import.meta.dir, '.install-test-'));
  assets = join(home, 'source-assets');
  destination = join(home, 'artifacts/vendor/drawio');
  fixture(assets);
});
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

function fixture(root: string, version = '32.6.9') {
  const files: Record<string, string> = {
    'index.html': '<script src="js/main.js"></script><link href="styles/grapheditor.css">',
    'js/app.min.js': `EditorUi.VERSION="${version}";`,
    'js/main.js': 'main', 'js/bootstrap.js': 'bootstrap',
    'js/grapheditor/Sidebar.js': "Sidebar.prototype.addGeneralPalette = function() { this.createVertexTemplateEntry('rounded=0;', 80, 80, '', 'Rectangle'); this.addEntry('list group erd table'",
    'styles/grapheditor.css': 'css', 'styles/high-contrast.css': 'css', 'mxgraph/mxClient.js': 'mxgraph',
    'img/lib/test/image.svg': '<svg viewBox="0 0 10 10"/>',
    'images/icon.svg': '<svg/>', 'resources/diagram.txt': 'resources',
    'stencils/test.xml': '<shapes/>', 'shapes/test.js': 'shape', 'templates/test.xml': '<template/>',
    'optional.txt': 'detect incomplete extraction beyond essential paths',
  };
  for (const [path, data] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), data);
  }
}

// A tiny real, stored ZIP exercises the OS extractor without downloading draw.io.
function zip(files: { name: string; data: Buffer; mode?: number }[]) {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name);
    let crc = 0xffffffff;
    for (const byte of file.data) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(file.data.length, 18); local.writeUInt32LE(file.data.length, 22); local.writeUInt16LE(name.length, 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50); entry.writeUInt16LE(0x0314, 4); entry.writeUInt16LE(20, 6);
    entry.writeUInt32LE(crc, 16); entry.writeUInt32LE(file.data.length, 20); entry.writeUInt32LE(file.data.length, 24); entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(((file.mode ?? 0x81a4) << 16) >>> 0, 38); entry.writeUInt32LE(offset, 42);
    locals.push(local, name, file.data); central.push(entry, name);
    offset += local.length + name.length + file.data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
function archive(root = assets) {
  const files: { name: string; data: Buffer }[] = [];
  const walk = (path = '') => {
    for (const entry of readdirSync(join(root, path), { withFileTypes: true })) {
      const name = path ? path + '/' + entry.name : entry.name;
      if (entry.isDirectory()) walk(name);
      else files.push({ name, data: readFileSync(join(root, name)) });
    }
  };
  walk();
  return zip(files);
}
function acquisition(bytes = archive(), extract = extractArchive) {
  const pinned = { url: 'https://fixture.invalid/archive', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  const download = async (path: string) => { writeFileSync(path, bytes); };
  return (work: string) => downloadAssets(work, { pinned, download, extract });
}
function privateFiles() {
  mkdirSync(join(home, 'artifacts'), { recursive: true });
  writeFileSync(join(home, 'artifacts/runtime.json'), '{"private":"fixture-only"}');
  mkdirSync(join(home, 'session-state/session/files'), { recursive: true });
  writeFileSync(join(home, 'session-state/session/files/drawing.svg'), 'saved drawing');
}
function preserved() {
  expect(readFileSync(join(home, 'artifacts/runtime.json'), 'utf8')).toBe('{"private":"fixture-only"}');
  expect(readFileSync(join(home, 'session-state/session/files/drawing.svg'), 'utf8')).toBe('saved drawing');
}
const noDownload = async () => { throw new Error('Unexpected acquisition'); };

test('official release URL, size and published digest stay pinned', () => {
  expect(release).toEqual({ url: 'https://github.com/jgraph/drawio/releases/download/v32.6.9/draw.war', size: 49_701_599, sha256: '31afc82b7920c409d0591f6126ccb6c377d7800e7f11ab324f88bdf1e4249ce7' });
});

test('missing assets use real ZIP validation/extraction and then reuse without acquisition', async () => {
  privateFiles();
  expect(await ensureAssets({ destination, acquire: acquisition() })).toBe(destination);
  validateAssets(destination);
  expect(await ensureAssets({ destination, acquire: noDownload })).toBe(destination);
  preserved();
  expect(existsSync(destination + '.prepare.lock')).toBe(false);
});

test('Node fetch follows a local redirect and streams archive bytes, rejecting unsuccessful responses', async () => {
  const bytes = archive();
  const server = createServer((request, response) => {
    if (request.url === '/redirect') { response.writeHead(302, { Location: '/archive' }); response.end(); }
    else if (request.url === '/archive') response.end(bytes);
    else { response.writeHead(503); response.end(); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as any).port}`;
  const pinned = { url: url + '/redirect', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  try {
    const work = join(home, 'fetch'); mkdirSync(work);
    validateAssets(await downloadAssets(work, { pinned }));
    await expect(fetchArchive(join(home, 'failed.zip'), { ...pinned, url: url + '/error' })).rejects.toThrow('HTTP 503');
    await expect(fetchArchive(join(home, 'too-large.zip'), { ...pinned, url: url + '/archive', size: 1 })).rejects.toThrow('exceeds pinned');
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('valid implicit candidate and explicit directory are reused without acquisition', async () => {
  expect(await ensureAssets({ destination, candidates: [join(home, 'missing'), assets], acquire: noDownload })).toBe(destination);
  expect(await ensureAssets({ destination: join(home, 'unused'), assets, acquire: noDownload })).toBe(assets);
  expect(existsSync(join(home, 'unused'))).toBe(false);
});

for (const failure of ['version', 'missing', 'empty', 'symlink']) {
  test(`explicit ${failure} assets reject without fallback or touching private files`, async () => {
    privateFiles();
    if (failure === 'version') fixture(assets, '99.0.0');
    if (failure === 'missing') rmSync(join(assets, 'js/main.js'));
    if (failure === 'empty') writeFileSync(join(assets, 'styles/grapheditor.css'), '');
    if (failure === 'symlink') symlinkSync(join(assets, 'index.html'), join(assets, 'linked.html'));
    await expect(ensureAssets({ destination, assets, acquire: noDownload })).rejects.toThrow('Explicit DRAWIO_ASSETS');
    preserved();
    expect(existsSync(destination)).toBe(false);
  });
}

for (const failure of ['download', 'checksum', 'truncated', 'extraction', 'incomplete', 'version', 'unsafe', 'symlink']) {
  test(`${failure} preparation failure preserves old assets and private files`, async () => {
    privateFiles();
    fixture(destination, 'old-version');
    let bytes = archive();
    let extract = extractArchive;
    if (failure === 'truncated') bytes = bytes.subarray(0, bytes.length - 12);
    if (failure === 'unsafe') bytes = zip([{ name: '../escape', data: Buffer.from('unsafe') }]);
    if (failure === 'symlink') bytes = zip([{ name: 'linked', data: Buffer.from('target'), mode: 0xa1ff }]);
    if (failure === 'version') { fixture(assets, '99.0.0'); bytes = archive(); }
    if (failure === 'extraction') extract = async () => { throw new Error('injected extraction failure'); };
    if (failure === 'incomplete') extract = async (zipFile, target) => { await extractArchive(zipFile, target); rmSync(join(target, 'optional.txt')); };
    const acquire = failure === 'download' ? async () => { throw new Error('download interrupted'); } : failure === 'checksum' ? async (work: string) => downloadAssets(work, { pinned: { ...release, size: bytes.length }, download: async path => { writeFileSync(path, bytes); } }) : acquisition(bytes, extract);
    await expect(ensureAssets({ destination, acquire })).rejects.toThrow('could not be prepared');
    expect(readFileSync(join(destination, 'js/app.min.js'), 'utf8')).toContain('old-version');
    preserved();
    expect(existsSync(destination + '.prepare.lock')).toBe(false);
  });
}

test('archive validator rejects duplicate, absolute and Windows traversal paths before extraction', () => {
  for (const name of ['/absolute', 'C:\\escape', 'folder/../escape', 'folder/./file', 'folder//file', 'file.', 'file ', 'NUL.txt']) expect(() => validateArchive(zip([{ name, data: Buffer.from('x') }]))).toThrow('Unsafe');
  expect(() => validateArchive(zip([{ name: 'file', data: Buffer.from('x') }, { name: 'FILE', data: Buffer.from('x') }]))).toThrow('Unsafe');
});

test('concurrent asset preparation publishes once and waiting caller reuses it', async () => {
  let acquired = 0;
  const acquire = async (work: string) => { acquired++; await delay(30); return acquisition()(work); };
  expect(await Promise.all([ensureAssets({ destination, acquire }), ensureAssets({ destination, acquire })])).toEqual([destination, destination]);
  expect(acquired).toBe(1);
});

test('failed publication restores the previous asset directory', async () => {
  privateFiles(); fixture(destination, 'old-version');
  const move = (from: string, to: string) => { if (from.endsWith('/ready')) throw new Error('injected publication failure'); renameSync(from, to); };
  await expect(ensureAssets({ destination, candidates: [assets], move })).rejects.toThrow('publication failure');
  expect(readFileSync(join(destination, 'js/app.min.js'), 'utf8')).toContain('old-version'); preserved();
});

test('interrupted preparation lock is not silently removed', async () => {
  mkdirSync(dirname(destination), { recursive: true }); mkdirSync(destination + '.prepare.lock');
  await expect(ensureAssets({ destination, acquire: noDownload, lockTimeoutMs: 1 })).rejects.toThrow('Inspect');
  expect(existsSync(destination + '.prepare.lock')).toBe(true);
});

test('Windows extraction uses OS PowerShell and literal paths via environment, not shell interpolation', async () => {
  const calls: any[] = [];
  const archive = "C:\\user's files\\draw.zip";
  const output = "C:\\user's files\\assets";
  await extractArchive(archive, output, { platform: 'win32', execute: async (...args) => { calls.push(args); } });
  expect(calls[0][0]).toBe('powershell.exe');
  expect(calls[0][1].join(' ')).not.toContain(archive);
  expect(calls[0][2].DRAWIO_ARCHIVE).toBe(archive);
  expect(calls[0][2].DRAWIO_OUTPUT).toBe(output);
});

test('rollback failure retains old assets, interrupted lock and recovery directory', async () => {
  privateFiles(); fixture(destination, 'old-version');
  const move = (from: string, to: string) => {
    if (from.endsWith('/ready')) {
      mkdirSync(destination); writeFileSync(join(destination, 'external-write'), 'preserved conflict');
      throw new Error('injected concurrent write');
    }
    renameSync(from, to);
  };
  await expect(ensureAssets({ destination, candidates: [assets], move })).rejects.toThrow('recovery files retained');
  const work = readdirSync(dirname(destination)).find(name => name.startsWith('.drawio-assets-'))!;
  expect(readFileSync(join(dirname(destination), work, 'previous/js/app.min.js'), 'utf8')).toContain('old-version');
  expect(readFileSync(join(destination, 'external-write'), 'utf8')).toBe('preserved conflict');
  expect(existsSync(destination + '.prepare.lock')).toBe(true);
  preserved();
});
