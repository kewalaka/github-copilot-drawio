import { test, expect } from 'bun:test';
import { deflateRawSync } from 'node:zlib';
import { applyOperations, diagramXml, parse, topology, validateSvg } from '../model';
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
test('rejects malformed XML, entities and image-only SVGs', () => {
  expect(() => diagramXml('<mxfile>')).toThrow('Malformed');
  expect(() => diagramXml('<!DOCTYPE x><mxfile/>')).toThrow();
  expect(() => diagramXml('<svg/>')).toThrow('embedded');
});
