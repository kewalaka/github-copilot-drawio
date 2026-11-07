import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage } from 'node:http';
import { resolve, dirname, extname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyOperations, BridgeError, diagramXml, documentContent, validateSvg, type Operation } from './model';
import { emptyDrawing } from './empty';
import { createShapeSearch } from './shapes';
import { openDesktop } from './desktop';

type BridgeOptions = {
  filename: string;
  runtimeFile: string;
  assets: string;
  port?: number;
  publicFiles?: Record<string, string>;
  publicDir?: string;
};

export async function startBridge(options: BridgeOptions) {
  const root = dirname(fileURLToPath(import.meta.url));
  const assets = resolve(options.assets);
  const searchShapes = createShapeSearch(assets);
  const filename = resolve(options.filename);
  if (!filename.endsWith('.drawio.svg')) throw new Error('Drawing file must end in .drawio.svg');
  if (resolve(options.runtimeFile) === filename) throw new Error('Runtime configuration must not replace the drawing file');
  mkdirSync(dirname(filename), { recursive: true });
  const token = randomBytes(32).toString('hex');
  const hash = (data: string) => createHash('sha256').update(data).digest('hex');
  const diskHash = () => existsSync(filename) ? hash(readFileSync(filename, 'utf8')) : null;
  let persistedHash = diskHash();
  const initialSvg = persistedHash ? readFileSync(filename, 'utf8') : null;
  let xml = initialSvg ? diagramXml(initialSvg) : emptyDrawing();
  if (initialSvg) validateSvg(initialSvg, xml);
  let revision = 0;
  let savedRevision = persistedHash ? 0 : -1;
  let editor: string | null = null;
  let editorLease: string | null = null;
  let lastSeen = 0;
  let lock: string | null = null;
  const handoffFile = filename + '.handoff';
  let paused = existsSync(handoffFile);
  let handoffOwner: string | null = null;
  let launching = false;
  let desktopOpened = false;
  const jobs = new Map<string, { id: string; status: string; expectedRevision: number; xml: string; error?: string; result?: unknown; expires: number }>();
  const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
  const documentState = () => ({ filename, revision, savedRevision, xml, dirty: revision !== savedRevision, paused });
  function finishHandoff() {
    if (existsSync(handoffFile)) unlinkSync(handoffFile);
    paused = false; handoffOwner = null; desktopOpened = false;
  }
  function checkHandoff(body: any) {
    if (launching || desktopOpened) throw new BridgeError('Close draw.io desktop, then resume here', 409);
    if (!paused || !handoffOwner || body.editorId !== handoffOwner) throw new BridgeError('No handoff belongs to this editor', 409);
  }
  function checkIdle() {
    if (launching || revision !== savedRevision || lock || Array.from(jobs.values()).some(job => ['queued', 'rendering'].includes(job.status))) throw new BridgeError('Save the drawing and finish pending updates before handing it off', 409);
  }
  function checkDisk() {
    if (diskHash() !== persistedHash) throw new BridgeError('The file changed outside this editor. Your saved file was not overwritten. Restart the bridge after resolving the file changes.', 409);
  }
  function checkRevision(expected: number) {
    checkDisk();
    if (expected !== revision) throw new BridgeError('Diagram changed; read the latest state and retry', 409);
  }
  function releaseEditor() {
    editor = null; editorLease = null; lastSeen = 0;
  }
  function releaseExpired() {
    for (const job of jobs.values()) if (['queued', 'rendering'].includes(job.status) && job.expires < Date.now()) {
      job.status = 'failed'; job.error = 'Editor update timed out';
      if (lock === job.id) lock = null;
    }
    if (editor && Date.now() - lastSeen > 15_000) releaseEditor();
  }
  function save(svg: string, expectedRevision: number, expectedXml: string) {
    checkRevision(expectedRevision);
    svg = validateSvg(svg, expectedXml);
    const temporary = filename + '.' + randomBytes(8).toString('hex') + '.tmp';
    try {
      writeFileSync(temporary, svg, { mode: 0o600, flag: 'wx' });
      checkDisk();
      renameSync(temporary, filename);
    } finally { if (existsSync(temporary)) unlinkSync(temporary); }
    persistedHash = hash(svg);
  }
  function editorRequest(body: any) {
    if (body.editorId !== editor || !editor) throw new BridgeError('This editor no longer owns the document; reload', 409);
    lastSeen = Date.now();
  }
  const csp = "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'self'";
  let port = 0;
  async function handle(request: Request) {
    const url = new URL(request.url);
    const host = `127.0.0.1:${port}`;
    if (request.headers.get('host') !== host) return json({ error: 'Invalid host' }, 403);
    try {
      releaseExpired();
      if (url.pathname === '/health' && request.method === 'GET') return json({ ok: true });
      if (url.pathname.startsWith('/api/')) {
        if (request.headers.get('authorization') !== `Bearer ${token}`) throw new BridgeError('Authentication required', 401);
        const origin = request.headers.get('origin');
        if (origin && origin !== url.origin) throw new BridgeError('Invalid origin', 403);
        if (request.method === 'GET') {
          if (url.pathname === '/api/document') { if (!paused) checkDisk(); return json(documentState()); }
          if (url.pathname === '/api/shapes') {
            if (Array.from(url.searchParams.keys()).some(key => !['query', 'limit'].includes(key)) || url.searchParams.getAll('query').length > 1 || url.searchParams.getAll('limit').length > 1) throw new BridgeError('Unknown or repeated shape search parameter');
            return json(searchShapes({ query: url.searchParams.get('query') ?? '', ...(url.searchParams.has('limit') ? { limit: Number(url.searchParams.get('limit')) } : {}) }));
          }
          if (url.pathname === '/api/jobs') {
            const id = url.searchParams.get('editorId');
            editorRequest({ editorId: id });
            return json({ job: Array.from(jobs.values()).find(j => j.status === 'queued') ?? null });
          }
          if (url.pathname.startsWith('/api/jobs/')) {
            const job = jobs.get(url.pathname.slice('/api/jobs/'.length));
            if (!job) throw new BridgeError('Job not found', 404);
            return json(job);
          }
        }
        if (request.method !== 'POST') throw new BridgeError('Unknown endpoint', 404);
        const body = await request.json();
        if (url.pathname === '/api/editor/release') {
          const released = editor !== null && body.editorId === editor && body.editorLease === editorLease;
          if (released) releaseEditor();
          return json({ released });
        }
        if (url.pathname === '/api/editor') {
          if (editor && editor !== body.editorId) throw new BridgeError('This drawing is open in another editor. Close that editor, then retry. If it crashed, recovery can take up to 15 seconds.', 409);
          if (typeof body.editorId !== 'string' || !/^[\w-]{1,100}$/.test(body.editorId)) throw new BridgeError('Invalid editor identifier');
          if (paused) {
            if (body.resume !== true) throw new BridgeError('Drawing is handed off. Close the other editor, then resume here.', 409);
            checkIdle();
            const svg = readFileSync(filename, 'utf8');
            const nextXml = diagramXml(svg);
            validateSvg(svg, nextXml);
            const nextHash = hash(svg);
            if (nextHash !== persistedHash) { xml = nextXml; persistedHash = nextHash; revision++; savedRevision = revision; }
            finishHandoff();
          } else checkDisk();
          editor = body.editorId; editorLease = randomBytes(16).toString('hex'); lastSeen = Date.now();
          return json({ ...documentState(), editorLease });
        }
        if (url.pathname === '/api/open-desktop') {
          checkHandoff(body);
          if (origin !== url.origin) throw new BridgeError('Open draw.io using the local editor button', 403);
          checkDisk();
          launching = true;
          try { desktopOpened = await openDesktop(filename); return json({ opened: desktopOpened }); }
          finally { launching = false; }
        }
        if (url.pathname === '/api/browser-handoff') {
          checkHandoff(body); checkDisk();
          finishHandoff();
          return json(documentState());
        }
        if (url.pathname === '/api/operations') {
          if (paused) throw new BridgeError('Drawing is handed off; wait for the user to resume here', 409);
          checkRevision(body.expectedRevision);
          if (!editor) throw new BridgeError('Open the editor before applying updates', 503);
          if (lock || Array.from(jobs.values()).some(j => j.status === 'queued')) throw new BridgeError('An update is already pending', 409);
          const nextXml = applyOperations(xml, body.operations as Operation[], body.relayout === true, body.pageId);
          const id = randomBytes(12).toString('hex');
          const job = { id, status: 'queued', expectedRevision: revision, xml: nextXml, expires: Date.now() + 30_000 };
          if (jobs.size >= 100) for (const [key, old] of jobs) { if (!['queued', 'rendering'].includes(old.status)) { jobs.delete(key); break; } }
          jobs.set(id, job);
          return json({ id, status: 'queued' }, 202);
        }
        editorRequest(body);
        if (url.pathname === '/api/handoff') {
          checkRevision(body.expectedRevision); checkIdle();
          writeFileSync(handoffFile, 'paused\n', { mode: 0o600, flag: 'wx' });
          paused = true; handoffOwner = editor; releaseEditor();
          return json(documentState());
        }
        if (url.pathname === '/api/draft') {
          if (lock) throw new BridgeError('An update is being saved', 409);
          checkRevision(body.expectedRevision);
          const nextXml = diagramXml(body.xml);
          if (nextXml !== xml && documentContent(nextXml) !== documentContent(xml)) { xml = nextXml; revision++; }
          return json(documentState());
        }
        if (url.pathname === '/api/save') {
          if (lock) throw new BridgeError('An update is being saved', 409);
          save(body.svg, body.expectedRevision, xml);
          savedRevision = revision;
          return json(documentState());
        }
        const job = jobs.get(body.jobId);
        if (!job) throw new BridgeError('Job not found', 404);
        if (url.pathname === '/api/begin') {
          if (job.status !== 'queued') throw new BridgeError('Job is not queued', 409);
          try { checkRevision(job.expectedRevision); } catch (error) {
            job.status = 'failed'; job.error = String(error); throw error;
          }
          lock = job.id; job.status = 'rendering';
          return json(job);
        }
        if (url.pathname === '/api/commit') {
          if (job.status !== 'rendering' || lock !== job.id) throw new BridgeError('Job no longer owns the save lock', 409);
          try {
            save(body.svg, job.expectedRevision, job.xml);
            xml = diagramXml(body.svg); revision++; savedRevision = revision;
            job.status = 'completed'; job.result = { revision, filename }; lock = null;
            return json(documentState());
          } catch (error) { job.status = 'failed'; job.error = String(error); lock = null; throw error; }
        }
        if (url.pathname === '/api/cancel') {
          if (['queued', 'rendering'].includes(job.status)) {
            job.status = 'failed'; job.error = 'Editor could not render or save this update';
          }
          if (lock === job.id) lock = null;
          return json(documentState());
        }
        throw new BridgeError('Unknown endpoint', 404);
      }
      if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
      let file: string;
      let content: string | Buffer;
      if (url.pathname === '/config.js') {
        return new Response(`window.BRIDGE_TOKEN=${JSON.stringify(token)};`, { headers: { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store', 'Content-Security-Policy': csp, 'Cross-Origin-Resource-Policy': 'same-origin' } });
      }
      if (url.pathname === '/diagram.svg') {
        checkDisk();
        if (!existsSync(filename)) throw new BridgeError('Diagram has not been saved yet', 404);
        file = filename;
        content = validateSvg(readFileSync(filename, 'utf8'), xml);
      } else {
        const editorAsset = url.pathname.startsWith('/drawio/');
        const directory = editorAsset ? assets : options.publicDir ?? `${root}/public`;
        const pathname = decodeURIComponent(editorAsset ? url.pathname.slice(8) : url.pathname.slice(1)) || 'index.html';
        file = resolve(directory, pathname);
        if (relative(directory, file).startsWith('..') || pathname.startsWith('WEB-INF/') || pathname.startsWith('META-INF/')) throw new BridgeError('Invalid asset path', 403);
        if (!editorAsset && options.publicFiles) {
          if (!Object.hasOwn(options.publicFiles, pathname)) throw new BridgeError('Not found', 404);
          content = options.publicFiles[pathname];
        } else {
          try { content = await readFile(file); }
          catch (error: any) {
            if (error.code === 'ENOENT' || error.code === 'EISDIR') throw new BridgeError('Not found', 404);
            throw error;
          }
        }
      }
      const mime: Record<string, string> = {
        '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.html': 'text/html',
        '.xml': 'application/xml', '.txt': 'text/plain', '.json': 'application/json',
        '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
        '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
        '.ttf': 'font/ttf', '.pdf': 'application/pdf', '.wasm': 'application/wasm',
      };
      return new Response(content, { headers: {
        'Content-Type': mime[extname(file)] ?? 'application/octet-stream',
        'Content-Security-Policy': csp, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
        'Cache-Control': url.pathname === '/diagram.svg' ? 'no-store' : 'no-cache',
        'Cross-Origin-Resource-Policy': 'same-origin',
      } });
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : 'Request failed' }, error instanceof BridgeError ? error.status : 400);
    }
  }
  const server = createServer(async (incoming, outgoing) => {
    try {
      const origin = `http://127.0.0.1:${port}`;
      const url = new URL(incoming.url ?? '/', origin);
      let response: Response;
      if (incoming.headers.host !== `127.0.0.1:${port}` || url.origin !== origin) {
        incoming.resume();
        response = json({ error: 'Invalid host' }, 403);
      } else {
        const headers = new Headers();
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
        }
        const hasBody = incoming.method !== 'GET' && incoming.method !== 'HEAD';
        const body = hasBody ? await readBody(incoming) : undefined;
        if (body === null) {
          outgoing.shouldKeepAlive = false;
          response = json({ error: 'Request body exceeds 24 MB' }, 413);
        } else {
          response = await handle(new Request(url, { method: incoming.method, headers, body }));
        }
      }
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      if (!outgoing.headersSent) {
        outgoing.writeHead(400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        outgoing.end(JSON.stringify({ error: 'Invalid request' }));
      } else outgoing.destroy();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  port = (server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}`;
  let closing: Promise<void> | undefined;
  const close = () => closing ??= new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  });
  const runtimeFile = resolve(options.runtimeFile);
  const temporaryRuntime = runtimeFile + '.' + randomBytes(8).toString('hex') + '.tmp';
  try {
    writeFileSync(temporaryRuntime, JSON.stringify({ url, token, filename, pid: process.pid }), { mode: 0o600, flag: 'wx' });
    renameSync(temporaryRuntime, runtimeFile);
  } catch (error) { await close(); throw error; }
  finally { if (existsSync(temporaryRuntime)) unlinkSync(temporaryRuntime); }
  return { url, close };
}

function readBody(incoming: IncomingMessage): Promise<Buffer | null> {
  const limit = 24_000_000;
  if (Number(incoming.headers['content-length']) > limit) {
    incoming.resume();
    return Promise.resolve(null);
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    incoming.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) { chunks.length = 0; resolve(null); }
      else chunks.push(chunk);
    });
    incoming.once('end', () => resolve(Buffer.concat(chunks)));
    incoming.once('error', reject);
    incoming.once('aborted', () => reject(new Error('Request aborted')));
  });
}
