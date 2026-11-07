const frame = document.querySelector('#editor');
const status = document.querySelector('#status');
const saveButton = document.querySelector('#save');
const busy = document.querySelector('#busy');
const openButton = document.querySelector('#open-drawio');
const resumeButton = document.querySelector('#resume');
const editorId = sessionStorage.bridgeEditorId ||= crypto.randomUUID();
let state;
let editorLease;
let ready = false;
let chain = Promise.resolve();
let pendingExport;
let suppressAutosave = false;
let stopped = false;
let unsaved = false;
let paused = false;
let browserFallback = false;
let pollGeneration = 0;

async function api(path, body, keepalive = false) {
  const response = await fetch('/api/' + path, {
    keepalive,
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${window.BRIDGE_TOKEN}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify({ ...body, editorId }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Request failed');
  return result;
}
function report(message, error = false) { status.textContent = message; status.classList.toggle('error', error); }
function enqueue(action) { chain = chain.then(action).catch(error => report(error.message, true)); return chain; }
function send(message) { frame.contentWindow.postMessage(JSON.stringify(message), location.origin); }
function block(value) {
  busy.hidden = !value && !paused;
  busy.textContent = paused ? 'Canvas paused. Close the other editor, then choose Resume here.' : 'Saving diagram…';
  frame.inert = value || paused;
  saveButton.disabled = value || !ready || paused;
  openButton.disabled = value || (paused ? !browserFallback : !ready);
  resumeButton.hidden = !paused;
  resumeButton.disabled = value || !paused;
}
function pause() {
  paused = true; stopped = true; pollGeneration++;
  sessionStorage.bridgePaused = '1';
  block(false);
}
function openBrowser() { window.open(location.origin + '/', '_blank', 'noopener'); }
function exportDiagram(format, xml) {
  if (pendingExport) return Promise.reject(new Error('An export is already pending'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pendingExport = null; reject(new Error('draw.io export timed out')); }, 20_000);
    pendingExport = { resolve: result => { clearTimeout(timer); pendingExport = null; resolve(result); }, reject };
    send({ action: 'export', format, xml, embedImages: true, embedFonts: false, allPages: true, background: '#ffffff', border: 20, theme: 'light' });
  });
}
function decodeSvg(data) {
  const separator = data.indexOf(',');
  if (separator < 0 || !data.startsWith('data:image/svg+xml')) throw new Error('Invalid SVG export');
  return data.slice(0, separator).includes(';base64')
    ? new TextDecoder().decode(Uint8Array.from(atob(data.slice(separator + 1)), c => c.charCodeAt(0)))
    : decodeURIComponent(data.slice(separator + 1));
}
async function recordDraft(xml) {
  state = await api('draft', { xml, expectedRevision: state.revision });
}
async function saveCurrent(xml) {
  unsaved = true;
  block(true);
  suppressAutosave = true;
  try {
    if (!xml) xml = (await exportDiagram('xml')).xml;
    await recordDraft(xml);
    const result = await exportDiagram('xmlsvg');
    state = await api('save', { svg: decodeSvg(result.data), expectedRevision: state.revision });
    unsaved = false;
    report(`Saved · revision ${state.revision}`);
  } finally { suppressAutosave = false; block(false); }
}
async function runJob(job) {
  block(true);
  suppressAutosave = true;
  let restore;
  let began = false;
  try {
    restore = (await exportDiagram('xml')).xml;
    await recordDraft(restore);
    const current = await api('begin', { jobId: job.id });
    began = true;
    const exported = await exportDiagram('xmlsvg', current.xml);
    state = await api('commit', { jobId: job.id, svg: decodeSvg(exported.data) });
    report(`Agent update saved · revision ${state.revision}`);
  } catch (error) {
    if (began && restore) send({ action: 'load', xml: restore, autosave: 1, title: 'Architecture', fit: 1 });
    await api('cancel', { jobId: job.id }).catch(() => {});
    report(error.message, true);
  } finally { suppressAutosave = false; block(false); }
}
window.addEventListener('message', event => {
  if (event.source !== frame.contentWindow || event.origin !== location.origin) return;
  let message;
  try { message = typeof event.data === 'string' ? JSON.parse(event.data) : event.data; } catch { return; }
  if (!message || paused) return;
  if (message.event === 'configure') send({ action: 'configure', config: {
    defaultLibraries: 'general;azure2', preserveViewState: true, useInternalClipboard: true,
    suppressNewWindows: true, enableLibraries: true,
  } });
  if (message.event === 'init') {
    ready = true; block(false);
    send({ action: 'load', xml: state.xml, autosave: 1, title: 'Architecture', fit: 1 });
  }
  if (message.event === 'load' && !suppressAutosave) {
    report(state.dirty ? 'Preparing first SVG…' : `Saved · revision ${state.revision}`);
    if (state.dirty) enqueue(() => saveCurrent());
  }
  if (message.event === 'export' && pendingExport) pendingExport.resolve(message);
  if (message.event === 'autosave' && ready && !suppressAutosave) {
    const xml = message.xml;
    unsaved = true;
    report('Saving manual edit…');
    enqueue(() => saveCurrent(xml));
  }
  if (message.event === 'save' && ready) {
    unsaved = true;
    enqueue(() => saveCurrent(message.xml));
  }
});
saveButton.addEventListener('click', () => enqueue(() => saveCurrent()));
document.querySelector('#preview').addEventListener('click', () => window.open('/diagram.svg', '_blank', 'noopener'));
openButton.addEventListener('click', () => {
  if (browserFallback) { openBrowser(); return; }
  block(true);
  enqueue(async () => {
    try {
      await saveCurrent();
      block(true);
      state = await api('handoff', { expectedRevision: state.revision });
      pause(); block(true);
      const { opened } = await api('open-desktop', {});
      if (opened) report('Opened in draw.io desktop. Close it before resuming here.');
      else {
        state = await api('browser-handoff', {});
        browserFallback = true;
        openButton.textContent = 'Open browser editor';
        report('Canvas paused. Continue in the local browser editor; if no window opens, click Open browser editor.');
        openBrowser();
      }
    } finally { block(false); }
  });
});
resumeButton.addEventListener('click', () => {
  block(true);
  enqueue(async () => { try { await connect(true); } finally { block(false); } });
});
window.addEventListener('beforeunload', event => {
  if (unsaved || state?.dirty || (!busy.hidden && !paused)) { event.preventDefault(); event.returnValue = ''; }
});
window.addEventListener('pagehide', () => {
  stopped = true; ready = false; pollGeneration++;
  if (editorLease) api('editor/release', { editorLease }, true).catch(() => {});
});
window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
async function poll() {
  const generation = ++pollGeneration;
  while (!stopped && generation === pollGeneration) {
    await new Promise(resolve => setTimeout(resolve, 800));
    if (stopped || generation !== pollGeneration) return;
    try {
      const { job } = await api('jobs?editorId=' + encodeURIComponent(editorId));
      if (stopped || generation !== pollGeneration) return;
      if (job && ready) await enqueue(() => runJob(job));
    } catch (error) {
      if (generation === pollGeneration) { report(error.message, true); stopped = true; }
    }
  }
}
async function connect(resume = false) {
  state = await api('editor', { resume });
  editorLease = state.editorLease;
  paused = false; browserFallback = false; stopped = false; ready = false;
  delete sessionStorage.bridgePaused;
  openButton.textContent = 'Open in Draw.io';
  block(false);
  frame.src = '/drawio/index.html?embed=1&proto=json&configure=1&offline=1&local=1&stealth=1&ui=min&libraries=1&noExitBtn=1&lang=en';
  poll();
}
connect().catch(async error => {
  state = await api('document').catch(() => null);
  if (state?.paused || sessionStorage.bridgePaused === '1') pause();
  report(error.message, true);
});
