import { createCanvas, joinSession, CanvasError } from "@github/copilot-sdk/extension";
import { canvasOptions } from "./canvas.mjs";

const canvas = createCanvas(canvasOptions(CanvasError));
await joinSession({ canvases: [canvas] });
