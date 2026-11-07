import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const source = import.meta.dir;
const bridge = resolve(source, '../diagram-bridge');
const wrapperFiles = ['extension.mjs', 'canvas.mjs', 'bridge.mjs', 'session-bridge.mjs', 'guidance.mjs', 'copilot-extension.json', 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.txt', 'runtime.mjs', 'build-manifest.json', 'skills/drawio/SKILL.md'];
const copy = (root: string, file: string, target: string) => {
  mkdirSync(dirname(target), { recursive: true });
  cpSync(join(root, file), target, { recursive: true, dereference: true });
};

export async function installExtension({
  home = process.env.COPILOT_HOME || join(homedir(), '.copilot'),
  assets = process.env.DRAWIO_ASSETS,
  sourceDirectory = source,
  localAssets = join(bridge, 'vendor/drawio'),
  acquireAssets,
  move = renameSync,
} = {}) {
  const parent = join(resolve(home), 'extensions');
  const destination = join(parent, 'drawio-canvas');
  for (let directory = parent; ; directory = dirname(directory)) {
    if (existsSync(directory) && (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink())) throw new Error(`Unsafe installation directory: ${directory}`);
    if (directory === dirname(directory)) break;
  }
  mkdirSync(parent, { recursive: true });
  const lock = join(parent, '.drawio-canvas-install.lock');
  try { mkdirSync(lock); } catch { throw new Error(`Another installer may be running. Inspect ${lock} before retrying.`); }
  let work: string | undefined;
  let preserveBackup = false;
  try {
    work = mkdtempSync(join(parent, '.drawio-canvas-stage-'));
    const staged = join(work, 'new');
    for (const file of wrapperFiles) copy(sourceDirectory, file, join(staged, file));
    for (const file of wrapperFiles) {
      if (!readFileSync(join(staged, file)).length) throw new Error(`Empty implementation file: ${file}`);
    }
    const runtimeFile = join(staged, 'runtime.mjs');
    const metadata = JSON.parse(readFileSync(join(staged, 'build-manifest.json'), 'utf8'));
    const digest = createHash('sha256').update(readFileSync(runtimeFile)).digest('hex');
    if (metadata.target !== 'node' || metadata.dependency !== '@xmldom/xmldom@0.9.12' || digest !== metadata.runtimeSha256) throw new Error('Prebuilt Node runtime failed integrity validation; rebuild from the source checkout.');
    const runtime = await import(pathToFileURL(runtimeFile).href);
    if (typeof runtime.startBridge !== 'function' || typeof runtime.ensureAssets !== 'function') throw new Error('Incomplete Node runtime exports.');
    runtime.assertDirectories(parent);
    const preparedAssets = join(staged, 'artifacts/vendor/drawio');
    const selected = await runtime.ensureAssets({ destination: preparedAssets, assets, candidates: [localAssets, join(destination, 'artifacts/vendor/drawio')], acquire: acquireAssets });
    if (selected !== preparedAssets) cpSync(selected, preparedAssets, { recursive: true });
    runtime.validateAssets(preparedAssets);
    const result = await Bun.build({ entrypoints: [join(staged, 'extension.mjs')], target: 'node', external: ['@github/copilot-sdk/extension'] });
    if (!result.success) throw new Error(result.logs.join('\n'));
    const manifest = JSON.parse(readFileSync(join(staged, 'copilot-extension.json'), 'utf8'));
    if (manifest.name !== 'drawio-canvas' || manifest.version !== 1) throw new Error('Invalid extension manifest');

    const replaced: { path: string; old: boolean; installed: boolean }[] = [];
    try {
      // Keep private artifacts in place; only the managed vendor subtree moves.
      for (const path of [...wrapperFiles, 'artifacts/vendor/drawio']) {
        const target = join(destination, path);
        const backup = join(work, 'old', path);
        // Refuse symlinked parents rather than following them outside this home.
        for (let dir = dirname(target); dir !== parent; dir = dirname(dir)) {
          if (existsSync(dir) && (!lstatSync(dir).isDirectory() || lstatSync(dir).isSymbolicLink())) throw new Error(`Unsafe installation directory: ${dir}`);
        }
        mkdirSync(dirname(target), { recursive: true });
        mkdirSync(dirname(backup), { recursive: true });
        const entry = { path, old: existsSync(target), installed: false };
        replaced.push(entry);
        if (entry.old) move(target, backup);
        move(join(staged, path), target);
        entry.installed = true;
      }
    } catch (error) {
      try {
        for (const entry of replaced.reverse()) {
          const target = join(destination, entry.path);
          const backup = join(work, 'old', entry.path);
          if (entry.installed) rmSync(target, { recursive: true, force: true });
          if (existsSync(backup)) renameSync(backup, target);
        }
      } catch (rollback) {
        preserveBackup = true;
        throw new Error(`Rollback failed; retain recovery files at ${work}. ${rollback}`);
      }
      throw error;
    }
    return destination;
  } catch (error) {
    throw new Error(`Installation failed; do not reload the extension. ${error}`);
  } finally {
    if (work && !preserveBackup) rmSync(work, { recursive: true, force: true });
    if (!preserveBackup) rmSync(lock, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  if (process.argv.length > 2) throw new Error('Use COPILOT_HOME and DRAWIO_ASSETS; no positional arguments are accepted.');
  console.log(`Installed ${await installExtension()}. After saving drawings, deliberately reload through a supported host action or restart Copilot. This installer does neither.`);
}
