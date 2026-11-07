import { startBridge as startServer } from '../diagram-bridge/server';
import index from '../diagram-bridge/public/index.html';
import style from '../diagram-bridge/public/style.css';
import app from '../diagram-bridge/public/app.js';

export { ensureAssets, validateAssets, assertDirectories } from './install-assets';

export function startBridge(options: Parameters<typeof startServer>[0]) {
  return startServer({ ...options, publicFiles: { 'index.html': index, 'style.css': style, 'app.js': app } });
}
