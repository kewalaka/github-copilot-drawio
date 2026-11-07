import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readReleaseVersion } from './version.mjs';

const root = join(import.meta.dir, '..');

test('release metadata is independent of the extension manifest format and bundled runtime', () => {
  const config = JSON.parse(readFileSync(join(root, 'release-please-config.json'), 'utf8')).packages['.'];
  expect(config['release-type']).toBe('simple');
  expect(config['version-file']).toBe('drawio-canvas/version.txt');
  expect(config['initial-version']).toBe('0.1.0');
  expect(config['include-component-in-tag']).toBe(false);
  expect(config['include-v-in-tag']).toBe(true);
  expect(readReleaseVersion()).toMatch(/^\d+\.\d+\.\d+$/);
  expect(JSON.parse(readFileSync(join(import.meta.dir, 'copilot-extension.json'), 'utf8')).version).toBe(1);
  const sources = JSON.parse(readFileSync(join(import.meta.dir, 'build-manifest.json'), 'utf8')).sources;
  expect(sources['drawio-canvas/version.txt']).toBeUndefined();
});

test('reads new versions on startup without a module reload and rejects invalid release metadata', () => {
  const directory = mkdtempSync(join(tmpdir(), 'drawio-version-'));
  const filename = join(directory, 'version.txt');
  try {
    writeFileSync(filename, '0.1.0\n');
    expect(readReleaseVersion(filename)).toBe('0.1.0');
    writeFileSync(filename, '0.2.0\n');
    expect(readReleaseVersion(filename)).toBe('0.2.0');
    for (const invalid of ['', '1', 'v1.0.0', '01.0.0', '1.0.0-rc.1', 'invalid']) {
      writeFileSync(filename, invalid);
      expect(() => readReleaseVersion(filename)).toThrow('Invalid extension release version');
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('release workflow uses the pinned action and built-in token without auto-merge or external publication', () => {
  const workflow = Bun.YAML.parse(readFileSync(join(root, '.github/workflows/release-please.yml'), 'utf8')) as any;
  expect(workflow.on.push.branches).toEqual(['main']);
  expect(workflow.jobs.release.permissions).toEqual({ contents: 'write', issues: 'write', 'pull-requests': 'write' });
  expect(workflow.jobs.release.steps).toHaveLength(1);
  const step = workflow.jobs.release.steps[0];
  expect(step.uses).toMatch(/^googleapis\/release-please-action@[a-f0-9]{40}$/);
  expect(step.with.token).toBe('${{ secrets.GITHUB_TOKEN }}');
  expect(step.with['config-file']).toBe('release-please-config.json');
  expect(step.with['manifest-file']).toBe('.release-please-manifest.json');
});
