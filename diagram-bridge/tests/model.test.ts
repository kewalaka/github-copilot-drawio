import { test, expect } from 'bun:test';
import { deflateRawSync } from 'node:zlib';
import { applyOperations, diagramXml, documentContent, parse, topology, validateSvg } from '../model';
import { seed } from '../seed';
const escape = (s: string) => s.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
const svg = (xml: string) => `<svg xmlns="http://www.w3.org/2000/svg" content="${escape(xml)}"><rect width="100" height="100"/></svg>`;

test('seed has nested ownership, network placement and typed connections', () => {
  const xml = seed();
  expect(xml).toContain('parent="subnet"');
  expect(xml).toContain('private endpoint association');
  expect(xml).toContain('strokeColor=#0078d4');
});
test('label updates preserve all geometry', () => {
  const before = seed();
  const after = applyOperations(before, [{ kind: 'update', id: 'function', label: 'Updated ingestion' }]);
  const geometry = (xml: string) => Array.from(parse(xml).getElementsByTagName('mxGeometry'), g => g.toString());
  expect(geometry(after)).toEqual(geometry(before));
});
test('document comparison ignores serialisation whitespace but protects metadata, layout and cell order', () => {
  const xml = seed();
  const formatted = xml.replaceAll('><', '>\n  <').replace('id="architecture" name="Resource organisation"', 'name="Resource organisation" id="architecture"');
  expect(documentContent(formatted)).toBe(documentContent(xml));
  expect(documentContent(xml.replace('page="0"', 'page="1"'))).not.toBe(documentContent(xml));
  expect(documentContent(applyOperations(xml, [{ kind: 'update', id: 'function', label: 'Manual change' }]))).not.toBe(documentContent(xml));
  expect(documentContent(applyOperations(xml, [{ kind: 'update', id: 'function', geometry: { x: 1, y: 2, width: 64, height: 64 } }], true))).not.toBe(documentContent(xml));
  const reordered = parse(xml);
  const cell = Array.from(reordered.getElementsByTagName('mxCell')).find(cell => cell.getAttribute('id') === 'function')!;
  cell.parentNode!.appendChild(cell);
  expect(topology(reordered.toString())).toBe(topology(xml));
  expect(documentContent(reordered.toString())).not.toBe(documentContent(xml));
});

test('connection updates preserve user-defined waypoints', () => {
  const doc = parse(seed());
  const edge = Array.from(doc.getElementsByTagName('mxCell')).find(cell => cell.getAttribute('id') === 'pe-association')!;
  const geometry = edge.getElementsByTagName('mxGeometry')[0];
  const points = doc.createElement('Array');
  points.setAttribute('as', 'points');
  for (const [x, y] of [[480, 180], [640, 260]]) {
    const point = doc.createElement('mxPoint');
    point.setAttribute('x', String(x));
    point.setAttribute('y', String(y));
    points.appendChild(point);
  }
  geometry.appendChild(points);
  const updated = applyOperations(doc.toString(), [{ kind: 'update', id: 'pe-association', label: 'Updated connection', relation: 'network' }]);
  const result = Array.from(parse(updated).getElementsByTagName('mxCell')).find(cell => cell.getAttribute('id') === 'pe-association')!;
  expect(result.getElementsByTagName('mxGeometry')[0].toString()).toBe(geometry.toString());
});

test('existing geometry and reparenting require explicit relayout', () => {
  expect(() => applyOperations(seed(), [{ kind: 'update', id: 'function', geometry: { x: 10, y: 10, width: 66, height: 66 } }])).toThrow('explicit relayout');
  expect(() => applyOperations(seed(), [{ kind: 'update', id: 'function', parent: 'rg-core' }])).toThrow('explicit relayout');
  expect(applyOperations(seed(), [{ kind: 'update', id: 'function', geometry: { x: 10, y: 10, width: 66, height: 66 } }], true)).toContain('x="10"');
});
test('SVG preserves embedded XML, including compressed draw.io input', () => {
  const xml = seed();
  expect(topology(diagramXml(svg(xml)))).toBe(topology(xml));
  const model = parse(xml).getElementsByTagName('mxGraphModel')[0].toString();
  const compressed = deflateRawSync(encodeURIComponent(model)).toString('base64');
  const input = `<mxfile><diagram id="architecture" name="Resource organisation">${compressed}</diagram></mxfile>`;
  expect(topology(input)).toBe(topology(xml));
  expect(validateSvg(svg(xml), xml)).toContain('<rect');
});
test('rejects external/active SVG and mismatched embedded data', () => {
  const xml = seed();
  expect(() => validateSvg(svg(xml).replace('<rect', '<script/><rect'), xml)).toThrow('Active SVG');
  expect(() => validateSvg(svg(xml).replace('<rect', '<image href="https://example.com/a.svg"/><rect'), xml)).toThrow('External SVG');
  const changed = applyOperations(xml, [{ kind: 'update', id: 'storage', label: 'Changed' }]);
  expect(() => validateSvg(svg(changed), xml)).toThrow('expected editable diagram');
});
test('rejects invalid identifiers, references, containment cycles and orphaning', () => {
  expect(() => applyOperations(seed(), [{ kind: 'add', id: 'function', label: 'duplicate' }])).toThrow('already exists');
  expect(() => applyOperations(seed(), [{ kind: 'update', id: 'subscription', parent: 'subnet' }], true)).toThrow('cycle');
  expect(() => applyOperations(seed(), [{ kind: 'remove', id: 'storage' }])).toThrow('connections first');
  expect(() => applyOperations(seed(), [{ kind: 'add', id: 'bad-edge', source: 'function', target: 'unknown', label: 'bad', relation: 'data' }])).toThrow('Connections need');
});
test('seed components fit their enclosing boxes and leave room for labels', () => {
  const cells = Array.from(parse(seed()).getElementsByTagName('mxCell'));
  for (const cell of cells.filter(c => c.getAttribute('vertex') === '1')) {
    const parent = cells.find(c => c.getAttribute('id') === cell.getAttribute('parent'));
    const bounds = parent?.getElementsByTagName('mxGeometry')[0];
    if (!bounds) continue;
    const g = cell.getElementsByTagName('mxGeometry')[0];
    expect(Number(g.getAttribute('x')) + Number(g.getAttribute('width'))).toBeLessThanOrEqual(Number(bounds.getAttribute('width')));
    const labelRoom = cell.getAttribute('style')?.includes('shape=image') ? 20 : 0;
    expect(Number(g.getAttribute('y')) + Number(g.getAttribute('height')) + labelRoom).toBeLessThanOrEqual(Number(bounds.getAttribute('height')));
  }
});
test('updates connection endpoints and relation styles without moving components', () => {
  const xml = applyOperations(seed(), [{ kind: 'update', id: 'pe-association', target: 'vault', relation: 'network' }]);
  const edge = Array.from(parse(xml).getElementsByTagName('mxCell')).find(c => c.getAttribute('id') === 'pe-association')!;
  expect(edge.getAttribute('target')).toBe('vault');
  expect(edge.getAttribute('style')).toContain('strokeColor=#0078d4');
  expect(edge.getAttribute('style')).not.toContain('dashed=1');
  expect(() => applyOperations(seed(), [{ kind: 'update', id: 'function', target: 'vault' }])).toThrow('Only connections');
  expect(() => applyOperations(seed(), [{ kind: 'update', id: 'pe-association', target: 'unknown' }])).toThrow('endpoint not found');
});
test('strips help links and rejects active HTML and external styles in SVG exports', () => {
  const xml = seed();
  expect(validateSvg(svg(xml).replace('<rect', '<a href="https://example.com">Help</a><rect'), xml)).not.toContain('https://example.com');
  for (const content of ['<img src="https://example.com/a.png"/>', '<style>@import "https://example.com/style.css";</style>', '<input/>', '<animateMotion/>']) {
    expect(() => validateSvg(svg(xml).replace('<rect', content + '<rect'), xml)).toThrow();
  }
});
const ffModel = '<mxGraphModel><root><mxCell id="ff-0"/><mxCell id="ff-1" parent="ff-0"/><mxCell id="ff-2" parent="ff-0"/><mxCell id="aws" value="AWS Account" vertex="1" parent="ff-1"><mxGeometry x="20" y="30" width="400" height="200" as="geometry"/></mxCell></root></mxGraphModel>';
const ffDrawing = () => seed().replace('</mxfile>', `<diagram id="ff" name="FF">${ffModel}</diagram></mxfile>`);

test('accepts duplicated pages with prefixed graph root and layer IDs', () => {
  const xml = diagramXml(ffDrawing());
  expect(parse(xml).getElementsByTagName('diagram')).toHaveLength(2);
  expect(xml).toContain('id="ff-0"');
  expect(topology(validateSvg(svg(xml), xml))).toBe(topology(xml));
  const compressed = deflateRawSync(encodeURIComponent(ffModel)).toString('base64');
  expect(topology(`<mxfile><diagram id="ff" name="FF">${compressed}</diagram></mxfile>`))
    .toBe(topology(`<mxfile><diagram id="ff" name="FF">${ffModel}</diagram></mxfile>`));
});

test('page-specific operations use the actual default layer and preserve other pages and layout', () => {
  const before = ffDrawing();
  const after = applyOperations(before, [
    { kind: 'update', id: 'aws', label: 'AWS account boundary' },
    { kind: 'add', id: 'gateway', label: 'API Gateway (AWS)', geometry: { x: 20, y: 40, width: 100, height: 60 } },
    { kind: 'add', id: 'mcp', parent: 'aws', label: 'MCP', geometry: { x: 160, y: 40, width: 100, height: 60 } },
  ], false, 'ff');
  const pages = parse(after).getElementsByTagName('diagram');
  expect(pages[0].toString()).toBe(parse(before).getElementsByTagName('diagram')[0].toString());
  const cells = Array.from(pages[1].getElementsByTagName('mxCell'));
  expect(cells.find(c => c.getAttribute('id') === 'gateway')!.getAttribute('parent')).toBe('ff-1');
  expect(cells.find(c => c.getAttribute('id') === 'mcp')!.getAttribute('parent')).toBe('aws');
  expect(cells.find(c => c.getAttribute('id') === 'aws')!.getElementsByTagName('mxGeometry')[0].toString())
    .toBe(parse(before).getElementsByTagName('diagram')[1].getElementsByTagName('mxGeometry')[0].toString());
});

test('protects actual graph roots and every layer from agent operations', () => {
  for (const id of ['ff-0', 'ff-1', 'ff-2']) {
    for (const kind of ['add', 'update', 'remove'] as const) {
      expect(() => applyOperations(ffDrawing(), [{ kind, id, label: 'Invalid' }], false, 'ff')).toThrow('reserved');
    }
  }
  expect(() => applyOperations(seed(), [{ kind: 'update', id: '0', label: 'Invalid' }])).toThrow('reserved');
  expect(() => applyOperations(seed(), [{ kind: 'remove', id: '1' }])).toThrow('reserved');
});

test('rejects absent, ambiguous or rendered graph roots and missing layers', () => {
  for (const root of [
    '', '<mxCell id="a"/><mxCell id="b"/>',
    '<mxCell id="a" vertex="1"/><mxCell id="b" parent="a"/>',
    '<mxCell id="a"/><mxCell id="b" parent="missing"/>',
    '<mxCell id="a"/><mxCell id="b" parent="a" vertex="1"/>',
  ]) {
    expect(() => diagramXml(`<mxGraphModel><root>${root}</root></mxGraphModel>`)).toThrow('Missing graph');
  }
  expect(() => diagramXml('<mxGraphModel><root><mxCell id="a"/><mxCell id="a" parent="a"/></root></mxGraphModel>')).toThrow('duplicate');
  expect(() => diagramXml('<mxGraphModel><mxCell id="0"/><mxCell id="1" parent="0"/></mxGraphModel>')).toThrow('Missing graph root');
});

test('rejects malformed XML, entities and image-only SVGs', () => {
  expect(() => diagramXml('<mxfile>')).toThrow('Malformed');
  expect(() => diagramXml('<!DOCTYPE x><mxfile/>')).toThrow();
  expect(() => diagramXml('<svg/>')).toThrow('embedded');
});
