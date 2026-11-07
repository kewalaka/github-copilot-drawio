import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { inflateRawSync } from 'node:zlib';

export class BridgeError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

export function parse(source: string) {
  if (typeof source !== 'string' || source.length > 12_000_000 || /<!DOCTYPE|<!ENTITY/i.test(source)) {
    throw new BridgeError('Invalid or oversized XML');
  }
  try {
    return new DOMParser({ onError: () => { throw new BridgeError('Malformed XML'); } }).parseFromString(source, 'text/xml');
  } catch { throw new BridgeError('Malformed XML'); }
}

function graphStructure(page: ReturnType<typeof parse>['documentElement']) {
  const models = page.getElementsByTagName('mxGraphModel');
  const roots = page.getElementsByTagName('root');
  if (models.length !== 1 || roots.length !== 1 || roots[0].parentNode !== models[0]) throw new BridgeError('Missing graph root');
  const root = roots[0];
  const cells = Array.from(root.getElementsByTagName('mxCell'));
  const idOf = (cell: typeof cells[number]) => cell.getAttribute('id') || cell.parentNode?.['getAttribute']?.('id');
  const ids = new Set<string>();
  for (const cell of cells) {
    const id = idOf(cell);
    if (!id || ids.has(id)) throw new BridgeError('Missing or duplicate cell identifier');
    ids.add(id);
  }
  const graphRoots = cells.filter(cell => !cell.hasAttribute('parent'));
  const isContainer = (cell: typeof cells[number]) => cell.getAttribute('vertex') !== '1' && cell.getAttribute('edge') !== '1';
  if (graphRoots.length !== 1 || !isContainer(graphRoots[0])) throw new BridgeError('Missing graph root');
  const rootId = idOf(graphRoots[0]);
  const layers = cells.filter(cell => cell.getAttribute('parent') === rootId && isContainer(cell));
  if (!layers.length) throw new BridgeError('Missing graph layer');
  return { root, rootId, layerIds: layers.map(idOf) };
}

export function diagramXml(source: string) {
  let doc = parse(source);
  if (doc.documentElement.tagName === 'svg') {
    const content = doc.documentElement.getAttribute('content');
    if (!content) throw new BridgeError('SVG has no embedded draw.io XML');
    doc = parse(content.startsWith('%') ? decodeURIComponent(content) : content);
  }
  if (doc.documentElement.tagName === 'mxGraphModel') {
    const wrapper = parse('<mxfile><diagram id="main" name="Architecture"/></mxfile>');
    wrapper.getElementsByTagName('diagram')[0].appendChild(wrapper.importNode(doc.documentElement, true));
    doc = wrapper;
  }
  if (doc.documentElement.tagName !== 'mxfile') throw new BridgeError('Expected draw.io XML');
  const pages = Array.from(doc.getElementsByTagName('diagram'));
  if (!pages.length || pages.length > 30) throw new BridgeError('Invalid page count');
  for (const page of pages) {
    if (!page.getElementsByTagName('mxGraphModel').length) {
      try {
        const xml = decodeURIComponent(inflateRawSync(Buffer.from(page.textContent ?? '', 'base64'), { maxOutputLength: 12_000_000 }).toString());
        const model = parse(xml).documentElement;
        if (model.tagName !== 'mxGraphModel') throw new Error();
        while (page.firstChild) page.removeChild(page.firstChild);
        page.appendChild(doc.importNode(model, true));
      } catch { throw new BridgeError('Invalid compressed diagram'); }
    }
    graphStructure(page);
  }
  doc.documentElement.setAttribute('compressed', 'false');
  return new XMLSerializer().serializeToString(doc);
}

function canonical(node: any): any {
  if (node.nodeType === 3) return node.nodeValue.trim() ? node.nodeValue : null;
  if (node.nodeType !== 1) return null;
  return [node.tagName, Array.from(node.attributes, (a: any) => [a.name, a.value]).sort(),
    Array.from(node.childNodes, canonical).filter(x => x !== null)];
}

export function documentContent(xml: string) {
  return JSON.stringify(canonical(parse(diagramXml(xml)).documentElement));
}

export function topology(xml: string) {
  const doc = parse(diagramXml(xml));
  return JSON.stringify(Array.from(doc.getElementsByTagName('diagram'), page => {
    const root = canonical(page.getElementsByTagName('root')[0]);
    root[2].sort((a: unknown, b: unknown) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    return { id: page.getAttribute('id'), name: page.getAttribute('name'), root };
  }));
}

export function validateSvg(svg: string, expectedXml: string) {
  const doc = parse(svg);
  if (doc.documentElement.tagName !== 'svg') throw new BridgeError('Expected SVG');
  for (const element of Array.from(doc.getElementsByTagName('*'))) {
    if (/^(script|iframe|object|embed|animate|animateMotion|animateTransform|set|audio|video|form|input|button|link|meta)$/i.test(element.localName)) throw new BridgeError('Active SVG content is not allowed');
    if (element.localName === 'style' && /@import|url\(\s*['"]?(?:https?:|\/\/)/i.test(element.textContent ?? '')) throw new BridgeError('External SVG stylesheet is not allowed');
    for (const attribute of Array.from(element.attributes)) {
      if (element.localName === 'a' && /(?:^|:)href$/.test(attribute.name) && !attribute.value.startsWith('#')) {
        element.removeAttribute(attribute.name);
        continue;
      }
      if (/^on/i.test(attribute.name)) throw new BridgeError('Active SVG attribute is not allowed');
      if (/^(src|srcset)$|(?:^|:)href$/.test(attribute.name) && !/^(#|data:image\/(svg\+xml|png|jpeg|gif|webp)[;,])/.test(attribute.value)) {
        throw new BridgeError('External SVG links or images are not allowed');
      }
      if (attribute.name !== 'content' && /(?:javascript:|@import|url\(\s*['"]?(?:https?:|\/\/))/i.test(attribute.value)) {
        throw new BridgeError('External or active SVG content is not allowed');
      }
    }
  }
  if (topology(diagramXml(svg)) !== topology(expectedXml)) throw new BridgeError('SVG does not contain the expected editable diagram');
  return new XMLSerializer().serializeToString(doc);
}

export type Operation = {
  kind: 'add' | 'update' | 'remove'; id: string; label?: string; parent?: string;
  style?: string; geometry?: { x: number; y: number; width: number; height: number };
  source?: string; target?: string; relation?: 'relationship' | 'network' | 'data';
};
const connectorStyles = {
  relationship: 'strokeColor=#64748b;dashed=1;endArrow=none;',
  network: 'strokeColor=#0078d4;endArrow=block;',
  data: 'strokeColor=#15803d;endArrow=block;',
};

export function applyOperations(source: string, operations: Operation[], relayout = false, pageId?: string) {
  if (!Array.isArray(operations) || !operations.length || operations.length > 200) throw new BridgeError('Provide 1–200 operations');
  const doc = parse(diagramXml(source));
  const pages = Array.from(doc.getElementsByTagName('diagram'));
  const page = pageId ? pages.find(p => p.getAttribute('id') === pageId) : pages[0];
  if (!page) throw new BridgeError('Page not found');
  const { root, rootId, layerIds } = graphStructure(page);
  const reserved = new Set([rootId, ...layerIds]);
  const find = (id: string) => Array.from(root.getElementsByTagName('mxCell')).find(c =>
    c.getAttribute('id') === id || c.parentNode?.['getAttribute']?.('id') === id);
  for (const op of operations) {
    if (!op || !['add', 'update', 'remove'].includes(op.kind) || typeof op.id !== 'string' || !/^[\w.-]{1,100}$/.test(op.id) || reserved.has(op.id)) {
      throw new BridgeError('Invalid operation or reserved cell identifier');
    }
    let cell = find(op.id);
    if (op.kind === 'add') {
      if (cell) throw new BridgeError(`Cell already exists: ${op.id}`);
      cell = doc.createElement('mxCell');
      cell.setAttribute('id', op.id);
      cell.setAttribute('parent', op.parent ?? layerIds[0]);
      if (op.source || op.target) {
        if (!op.source || !op.target || !find(op.source) || !find(op.target) || !op.relation || !Object.hasOwn(connectorStyles, op.relation) || !op.label) throw new BridgeError('Connections need endpoints, a label and a relation type');
        cell.setAttribute('edge', '1');
        cell.setAttribute('source', op.source);
        cell.setAttribute('target', op.target);
        cell.setAttribute('style', 'edgeStyle=orthogonalEdgeStyle;rounded=0;html=0;' + connectorStyles[op.relation]);
        const geometry = doc.createElement('mxGeometry');
        geometry.setAttribute('as', 'geometry');
        geometry.setAttribute('relative', '1');
        cell.appendChild(geometry);
      } else {
        if (!op.geometry) throw new BridgeError('New components need geometry');
        cell.setAttribute('vertex', '1');
        cell.setAttribute('style', 'rounded=1;whiteSpace=wrap;html=0;');
      }
      root.appendChild(cell);
    } else if (!cell) throw new BridgeError(`Cell not found: ${op.id}`, 409);
    if (op.kind === 'remove') {
      const dependent = Array.from(root.getElementsByTagName('mxCell')).some(c =>
        c.getAttribute('parent') === op.id || c.getAttribute('source') === op.id || c.getAttribute('target') === op.id);
      if (dependent) throw new BridgeError('Remove child components and connections first');
      const wrapper = cell!.parentNode;
      root.removeChild(wrapper !== root ? wrapper! : cell!);
      continue;
    }
    if (op.kind === 'update' && (op.source !== undefined || op.target !== undefined || op.relation !== undefined)) {
      if (cell!.getAttribute('edge') !== '1') throw new BridgeError('Only connections have endpoints and relation types');
      for (const key of ['source', 'target'] as const) if (op[key] !== undefined) {
        if (!find(op[key]!)) throw new BridgeError('Connection endpoint not found');
        cell!.setAttribute(key, op[key]!);
      }
      if (op.relation !== undefined) {
        if (!Object.hasOwn(connectorStyles, op.relation)) throw new BridgeError('Invalid relation type');
        const existing = (cell!.getAttribute('style') ?? '').split(';').filter(s => !/^(strokeColor|dashed|endArrow)=/.test(s)).join(';');
        cell!.setAttribute('style', existing + ';' + connectorStyles[op.relation]);
      }
    }
    if (op.parent !== undefined) {
      if (!find(op.parent) || op.parent === op.id) throw new BridgeError('Invalid parent');
      let ancestor = find(op.parent);
      const seen = new Set<string>();
      while (ancestor) {
        const id = ancestor.getAttribute('id')!;
        if (id === op.id || seen.has(id)) throw new BridgeError('Containment cycle');
        seen.add(id);
        ancestor = find(ancestor.getAttribute('parent') ?? '');
      }
      if (op.kind === 'update' && !relayout && op.parent !== cell!.getAttribute('parent')) throw new BridgeError('Reparenting requires explicit relayout');
      cell!.setAttribute('parent', op.parent);
    }
    if (op.label !== undefined) {
      if (typeof op.label !== 'string' || op.label.length > 2000) throw new BridgeError('Invalid label');
      if (cell!.parentNode !== root) cell!.parentNode!['setAttribute']('label', op.label);
      else cell!.setAttribute('value', op.label);
    }
    if (op.style !== undefined) {
      if (typeof op.style !== 'string' || /javascript:|https?:|\/\//i.test(op.style)) throw new BridgeError('Styles must use local assets');
      cell!.setAttribute('style', op.style);
    }
    if (op.geometry) {
      if (op.kind === 'update' && !relayout) throw new BridgeError('Moving existing components requires explicit relayout');
      if (cell!.getAttribute('edge') === '1') throw new BridgeError('Edge geometry cannot use vertex bounds');
      let geometry = cell!.getElementsByTagName('mxGeometry')[0];
      if (!geometry) { geometry = doc.createElement('mxGeometry'); geometry.setAttribute('as', 'geometry'); cell!.appendChild(geometry); }
      for (const key of ['x', 'y', 'width', 'height'] as const) {
        const value = op.geometry[key];
        if (!Number.isFinite(value) || Math.abs(value) > 100_000 || ((key === 'width' || key === 'height') && value <= 0)) throw new BridgeError('Invalid geometry');
        geometry.setAttribute(key, String(value));
      }
    }
  }
  return diagramXml(new XMLSerializer().serializeToString(doc));
}
