import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { buildShapeIndex } from '../diagram-bridge/shapes';

const source = import.meta.dir;
const bridge = resolve(source, '../diagram-bridge');

export function installExtension({ home = process.env.COPILOT_HOME || join(homedir(), '.copilot'), assets = join(bridge, 'vendor/drawio') } = {}) {
  buildShapeIndex(assets);
  const destination = join(resolve(home), 'extensions/drawio-canvas');
  const copy = (root: string, file: string, target: string) => {
    mkdirSync(dirname(target), { recursive: true });
    cpSync(join(root, file), target);
  };
  const cwd = join(destination, 'bridge');
  if (!existsSync(join(cwd, 'node_modules/@xmldom/xmldom/package.json'))) {
    for (const file of ['package.json', 'bun.lock']) copy(bridge, file, join(cwd, file));
    const installed = Bun.spawnSync([process.execPath, 'install', '--frozen-lockfile', '--production'], { cwd, stdout: 'pipe', stderr: 'pipe' });
    if (installed.exitCode !== 0) throw new Error('Bridge dependency installation failed; do not reload the extension.\n' + installed.stderr.toString());
  }
  for (const file of ['extension.mjs', 'canvas.mjs', 'bridge.mjs', 'session-bridge.mjs', 'guidance.mjs', 'copilot-extension.json', 'README.md', 'LICENSE', 'skills/drawio/SKILL.md']) {
    copy(source, file, join(destination, file));
  }
  for (const file of ['server.ts', 'model.ts', 'empty.ts', 'shapes.ts', 'package.json', 'bun.lock', 'public/index.html', 'public/style.css', 'public/app.js']) {
    copy(bridge, file, join(cwd, file));
  }
  cpSync(assets, join(destination, 'artifacts/vendor/drawio'), { recursive: true });
  return destination;
}

if (import.meta.main) {
  if (process.argv.length > 2) throw new Error('Use COPILOT_HOME to select the installation home; no positional arguments are accepted.');
  console.log(`Installed ${installExtension()}. Reload extensions in Copilot when existing drawings are saved.`);
}
