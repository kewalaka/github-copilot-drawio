import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { BridgeError } from './model';

export const editorVersion = '32.6.9';
type Shape = { id: string; label: string; category: string; style: string; width: number; height: number; asset?: string };
const words = (text: string) => text.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().toLowerCase();

export function buildShapeIndex(assets: string) {
  const fingerprint = createHash('sha256');
  const read = (path: string) => {
    const data = readFileSync(join(assets, path), 'utf8');
    fingerprint.update(path).update('\0').update(data).update('\0');
    return data;
  };
  try {
    const app = read('js/app.min.js');
    if (!app.includes(`EditorUi.VERSION="${editorVersion}"`)) throw new BridgeError(`Shape lookup requires draw.io ${editorVersion}; use the pinned local assets.`, 503);
    const sidebar = read('js/grapheditor/Sidebar.js');
    const palette = sidebar.slice(sidebar.indexOf('Sidebar.prototype.addGeneralPalette ='), sidebar.indexOf("this.addEntry('list group erd table'", sidebar.indexOf('Sidebar.prototype.addGeneralPalette =')));
    const shapes: Shape[] = [];
    // Only literal single-cell templates: no palette execution or computed styles.
    const templates = /this\.createVertexTemplateEntry\('([^']+)',\s*(\d+),\s*(\d+),\s*'[^']*',\s*'([^']+)'/g;
    for (const match of palette.matchAll(templates)) {
      if (/https?:|\/\/|javascript:/i.test(match[1])) continue;
      shapes.push({ id: 'general/' + words(match[4]).replaceAll(' ', '-') + '-' + createHash('sha256').update(match[1]).digest('hex').slice(0, 8), label: match[4], category: 'general', style: match[1], width: Number(match[2]), height: Number(match[3]) });
    }
    if (!shapes.length) throw new BridgeError('The local general palette does not match the shape index parser.', 503);
    function images(directory: string) {
      for (const entry of readdirSync(join(assets, directory), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const path = directory + '/' + entry.name;
        if (entry.isDirectory()) images(path);
        else if (entry.isFile() && entry.name.endsWith('.svg')) {
          const svg = read(path);
          const viewBox = svg.match(/viewBox\s*=\s*["']\s*[-\d.e+]+\s+[-\d.e+]+\s+([\d.e+]+)\s+([\d.e+]+)\s*["']/i);
          const ratio = viewBox ? Number(viewBox[1]) / Number(viewBox[2]) : 1;
          if (!Number.isFinite(ratio) || ratio <= 0) continue;
          const image = path.split('/').map(encodeURIComponent).join('/');
          const asset = '/drawio/' + image;
          shapes.push({ id: path, label: entry.name.slice(0, -4).replaceAll('_', ' '), category: directory.slice('img/lib/'.length), asset,
            style: `image;aspect=fixed;html=1;align=center;verticalLabelPosition=bottom;verticalAlign=top;image=${image};`,
            width: Math.max(1, Math.round(64 * Math.min(ratio, 1) * 100) / 100), height: Math.max(1, Math.round(64 / Math.max(ratio, 1) * 100) / 100) });
        }
      }
    }
    images('img/lib');
    return { editorVersion, assetFingerprint: fingerprint.digest('hex'), shapes };
  } catch (error) {
    if (error instanceof BridgeError) throw error;
    throw new BridgeError('Shape lookup needs the pinned local draw.io assets, including palette sources and SVG libraries.', 503);
  }
}

function assetSnapshot(assets: string) {
  const entries: string[] = [];
  const record = (path: string) => {
    const stat = statSync(join(assets, path), { bigint: true });
    entries.push(JSON.stringify([path, ...[stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String)]));
  };
  try {
    record('js/app.min.js');
    record('js/grapheditor/Sidebar.js');
    function images(directory: string) {
      record(directory);
      for (const entry of readdirSync(join(assets, directory), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const path = directory + '/' + entry.name;
        if (entry.isDirectory()) images(path);
        else if (entry.isFile() && entry.name.endsWith('.svg')) record(path);
      }
    }
    images('img/lib');
    return entries.join('\n');
  } catch {
    throw new BridgeError('Shape lookup needs the pinned local draw.io assets, including palette sources and SVG libraries.', 503);
  }
}

export function createShapeSearch(assets: string) {
  let cached: { snapshot: string; index: ReturnType<typeof buildShapeIndex>; fields: { shape: Shape; label: string; text: string }[] } | undefined;
  return (input: { query: string; limit?: number }) => {
    if (!input || Object.keys(input).some(key => !['query', 'limit'].includes(key)) || typeof input.query !== 'string' || !words(input.query) || input.query.length > 100 ||
        (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 50))) throw new BridgeError('Provide a shape query (1–100 characters) and limit (1–50).');
    // Check metadata, not asset contents, on warm searches. Directory scans also detect additions and removals.
    const snapshot = assetSnapshot(assets);
    if (!cached || cached.snapshot !== snapshot) {
      const index = buildShapeIndex(assets);
      cached = { snapshot, index, fields: index.shapes.map(shape => ({ shape, label: words(shape.label), text: words(shape.id + ' ' + shape.category + ' ' + shape.label) })) };
    }
    const { index, fields } = cached;
    const query = words(input.query);
    const terms = query.split(' ');
    const ranked = fields.map(({ shape, label, text }) => {
      const score = terms.every(term => text.includes(term)) ? terms.reduce((n, term) => n + (label.includes(term) ? 2 : 1), 0) + (label === query ? 10 : 0) : 0;
      return { shape, score };
    }).filter(item => item.score).sort((a, b) => b.score - a.score || a.shape.id.localeCompare(b.shape.id));
    return { editorVersion: index.editorVersion, assetFingerprint: index.assetFingerprint, indexed: index.shapes.length, total: ranked.length,
      coverage: 'Literal general palette templates and local SVG image libraries; not the complete stencil catalog. No remote fallback.',
      shapes: ranked.slice(0, input.limit ?? 10).map(item => item.shape) };
  };
}
