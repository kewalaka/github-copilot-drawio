const frame = document.querySelector('#editor');
const status = document.querySelector('#status');
const saveButton = document.querySelector('#save');
const busy = document.querySelector('#busy');
const editorId = sessionStorage.bridgeEditorId ||= crypto.randomUUID();
let state;
let ready = false;
let chain = Promise.resolve();
let pendingExport;
let suppressAutosave = false;
let stopped = false;
let unsaved = false;

async function api(path, body) {
  const response = await fetch('/api/' + path, {
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
function block(value) { busy.hidden = !value; frame.inert = value; saveButton.disabled = value || !ready; }
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
  if (!message) return;
  if (message.event === 'configure') send({ action: 'configure', config: {
    defaultLibraries: 'general;azure2', preserveViewState: true, useInternalClipboard: true,
    suppressNewWindows: true, enableLibraries: true,
  } });
  if (message.event === 'init') {
    ready = true; saveButton.disabled = false;
    send({ action: 'load', xml: state.xml, autosave: 1, title: 'Architecture', fit: 1 });
  }
  if (message.event === 'load' && !suppressAutosave) {
    report(state.dirty ? 'Preparing first SVG…' : `Saved · revision ${state.revision}`);
    if (state.dirty) enqueue(() => saveCurrent());
  }
  if (message.event === 'export' && pendingExport) pendingExport.resolve(message);
  if (message.event === 'autosave' && !suppressAutosave) {
    const xml = message.xml;
    unsaved = true;
    report('Saving manual edit…');
    enqueue(() => saveCurrent(xml));
  }
  if (message.event === 'save') {
    unsaved = true;
    enqueue(() => saveCurrent(message.xml));
  }
});
saveButton.addEventListener('click', () => enqueue(() => saveCurrent()));
window.addEventListener('beforeunload', event => {
  if (unsaved || state?.dirty || !busy.hidden) { event.preventDefault(); event.returnValue = ''; }
});
async function poll() {
  while (!stopped) {
    await new Promise(resolve => setTimeout(resolve, 800));
    try {
      const { job } = await api('jobs?editorId=' + encodeURIComponent(editorId));
      if (job && ready) await enqueue(() => runJob(job));
    } catch (error) { report(error.message, true); stopped = true; }
  }
}
api('editor', { editorId }).then(result => {
  state = result;
  frame.src = '/drawio/index.html?embed=1&proto=json&configure=1&offline=1&local=1&stealth=1&ui=min&libraries=1&noExitBtn=1&lang=en';
  poll();
}).catch(error => report(error.message, true));
