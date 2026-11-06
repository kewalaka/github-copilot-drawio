import { createCanvas, joinSession, CanvasError } from "@github/copilot-sdk/extension";
import { canvasOptions } from "./canvas.mjs";
import { SessionBridges } from "./session-bridge.mjs";
import { guidanceOptions } from "./guidance.mjs";

const bridges = new SessionBridges();
process.once("exit", () => bridges.stop());
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.once(signal, () => { bridges.stop(); process.exit(0); });
}
const canvas = createCanvas(canvasOptions(CanvasError, { bridges }));
await joinSession({ canvases: [canvas], ...guidanceOptions() });
