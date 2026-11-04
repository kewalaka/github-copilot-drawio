import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync } from 'node:fs';
import { resolve, dirname, extname, relative } from 'node:path';
import { applyOperations, BridgeError, diagramXml, validateSvg, type Operation } from './model';
import { seed } from './seed';

const root = import.meta.dir;
const filename = resolve(process.env.DIAGRAM_FILE ?? `${root}/diagrams/architecture.drawio.svg`);
if (!filename.endsWith('.drawio.svg')) throw new Error('DIAGRAM_FILE must end in .drawio.svg');
mkdirSync(dirname(filename), { recursive: true });
const token = randomBytes(32).toString('hex');
const hash = (data: string) => createHash('sha256').update(data).digest('hex');
const diskHash = () => existsSync(filename) ? hash(readFileSync(filename, 'utf8')) : null;
let persistedHash = diskHash();
const initialSvg = persistedHash ? readFileSync(filename, 'utf8') : null;
let xml = initialSvg ? diagramXml(initialSvg) : seed();
if (initialSvg) validateSvg(initialSvg, xml);
let revision = 0;
let savedRevision = persistedHash ? 0 : -1;
let editor: string | null = null;
let lastSeen = 0;
let lock: string | null = null;
const jobs = new Map<string, { id: string; status: string; expectedRevision: number; xml: string; error?: string; result?: unknown; expires: number }>();
const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
const documentState = () => ({ filename, revision, savedRevision, xml, dirty: revision !== savedRevision });
function checkDisk() {
  if (diskHash() !== persistedHash) throw new BridgeError('The file changed outside this editor. Your saved file was not overwritten. Restart the bridge after resolving the file changes.', 409);
}
function checkRevision(expected: number) {
  checkDisk();
  if (expected !== revision) throw new BridgeError('Diagram changed; read the latest state and retry', 409);
}
function releaseExpired() {
  for (const job of jobs.values()) if (['queued', 'rendering'].includes(job.status) && job.expires < Date.now()) {
    job.status = 'failed'; job.error = 'Editor update timed out';
    if (lock === job.id) lock = null;
  }
  if (editor && Date.now() - lastSeen > 15_000) editor = null;
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
const server = Bun.serve({
  hostname: '127.0.0.1', port: Number(process.env.PORT ?? 0), maxRequestBodySize: 24_000_000,
  async fetch(request) {
    const url = new URL(request.url);
    const host = `127.0.0.1:${server.port}`;
    if (request.headers.get('host') !== host) return json({ error: 'Invalid host' }, 403);
    try {
      releaseExpired();
      if (url.pathname === '/health' && request.method === 'GET') return json({ ok: true });
      if (url.pathname.startsWith('/api/')) {
        if (request.headers.get('authorization') !== `Bearer ${token}`) throw new BridgeError('Authentication required', 401);
        const origin = request.headers.get('origin');
        if (origin && origin !== url.origin) throw new BridgeError('Invalid origin', 403);
        if (request.method === 'GET') {
          if (url.pathname === '/api/document') { checkDisk(); return json(documentState()); }
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
        if (url.pathname === '/api/editor') {
          if (editor && editor !== body.editorId) throw new BridgeError('Another editor owns this document. Close it and wait 15 seconds, or use that editor.', 409);
          if (typeof body.editorId !== 'string' || !/^[\w-]{1,100}$/.test(body.editorId)) throw new BridgeError('Invalid editor identifier');
          editor = body.editorId; lastSeen = Date.now();
          return json(documentState());
        }
        if (url.pathname === '/api/operations') {
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
        if (url.pathname === '/api/draft') {
          if (lock) throw new BridgeError('An update is being saved', 409);
          checkRevision(body.expectedRevision);
          const nextXml = diagramXml(body.xml);
          if (nextXml !== xml) { xml = nextXml; revision++; }
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
      if (url.pathname === '/config.js') {
        return new Response(`window.BRIDGE_TOKEN=${JSON.stringify(token)};`, { headers: { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store', 'Content-Security-Policy': csp, 'Cross-Origin-Resource-Policy': 'same-origin' } });
      }
      if (url.pathname === '/diagram.svg') {
        checkDisk();
        if (!existsSync(filename)) throw new BridgeError('Diagram has not been saved yet', 404);
        file = filename;
      } else {
        const editorAsset = url.pathname.startsWith('/drawio/');
        const directory = editorAsset ? `${root}/vendor/drawio` : `${root}/public`;
        const pathname = decodeURIComponent(editorAsset ? url.pathname.slice(8) : url.pathname.slice(1)) || 'index.html';
        file = resolve(directory, pathname);
        if (relative(directory, file).startsWith('..') || pathname.startsWith('WEB-INF/') || pathname.startsWith('META-INF/')) throw new BridgeError('Invalid asset path', 403);
      }
      const content = Bun.file(file);
      if (!await content.exists()) throw new BridgeError('Not found', 404);
      const mime: Record<string, string> = { '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.html': 'text/html', '.xml': 'application/xml', '.txt': 'text/plain' };
      return new Response(content, { headers: {
        'Content-Type': mime[extname(file)] ?? content.type,
        'Content-Security-Policy': csp, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
        'Cache-Control': url.pathname === '/diagram.svg' ? 'no-store' : 'no-cache',
        'Cross-Origin-Resource-Policy': 'same-origin',
      } });
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : 'Request failed' }, error instanceof BridgeError ? error.status : 400);
    }
  },
});
const runtimePath = resolve(process.env.BRIDGE_RUNTIME ?? `${root}/runtime.json`);
writeFileSync(runtimePath, JSON.stringify({ url: `http://127.0.0.1:${server.port}`, token, filename, pid: process.pid }), { mode: 0o600 });
console.log(`Diagram bridge ready: http://127.0.0.1:${server.port}`);
