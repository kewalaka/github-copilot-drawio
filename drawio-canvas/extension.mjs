import { createCanvas, joinSession, CanvasError } from "@github/copilot-sdk/extension";
import { canvasOptions } from "./canvas.mjs";
import { SessionBridges } from "./session-bridge.mjs";
import { guidanceOptions } from "./guidance.mjs";

const bridges = new SessionBridges();
let shuttingDown = false;
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.once(signal, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    try { await bridges.stop(); }
    finally { process.exit(0); }
  });
}
const canvas = createCanvas(canvasOptions(CanvasError, { bridges }));
try { await joinSession({ canvases: [canvas], ...guidanceOptions() }); }
catch (error) { await bridges.stop(); throw error; }
