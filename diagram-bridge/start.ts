import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startBridge } from './server';

const root = dirname(fileURLToPath(import.meta.url));
const localAssets = join(root, 'vendor/drawio');
const runtimeFile = resolve(process.env.BRIDGE_RUNTIME ?? join(root, 'runtime.json'));
mkdirSync(dirname(runtimeFile), { recursive: true, mode: 0o700 });
const bridge = await startBridge({
  filename: resolve(process.env.DIAGRAM_FILE ?? join(root, 'diagrams/architecture.drawio.svg')),
  runtimeFile,
  assets: resolve(process.env.DRAWIO_ASSETS ?? (existsSync(join(localAssets, 'index.html')) ? localAssets : join(root, '../artifacts/vendor/drawio'))),
  port: Number(process.env.PORT ?? 0),
});

console.log(bridge.url);
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    await bridge.close();
    process.exit(0);
  });
}
