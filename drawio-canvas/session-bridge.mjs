import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { readRuntime, request, BridgeError } from "./bridge.mjs";

const extensionDir = dirname(fileURLToPath(import.meta.url));

async function verifyDocument(runtime, filename) {
  if (runtime.filename !== filename || (await request(runtime, "document")).filename !== filename) {
    throw new BridgeError("drawio_document_changed", "This session's bridge points to another drawing. Check its private runtime configuration before reopening.");
  }
}

export class SessionBridges {
  constructor({ home = process.env.COPILOT_HOME || join(homedir(), ".copilot"), bun = "bun",
    bridgeDir = join(extensionDir, "bridge"), assetsDir = join(extensionDir, "artifacts", "vendor", "drawio") } = {}) {
    this.home = home;
    this.bun = bun;
    this.bridgeDir = bridgeDir;
    this.assetsDir = assetsDir;
    this.sessions = new Map();
    this.children = new Set();
  }

  directory(sessionId) {
    if (typeof sessionId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(sessionId)) {
      throw new BridgeError("drawio_session_invalid", "A valid session ID is required for separate diagram storage.");
    }
    return join(this.home, "session-state", sessionId, "files", "diagram-bridge");
  }

  async runtimeFile(sessionId) {
    let pending = this.sessions.get(sessionId);
    if (pending) {
      const runtimeFile = await pending;
      try {
        await verifyDocument(readRuntime(runtimeFile), join(this.directory(sessionId), "architecture.drawio.svg"));
        return runtimeFile;
      }
      catch (error) {
        if (!["drawio_bridge_unavailable", "drawio_runtime_invalid"].includes(error.code)) throw error;
        this.sessions.delete(sessionId);
      }
    }
    pending = this.start(sessionId);
    this.sessions.set(sessionId, pending);
    try { return await pending; }
    catch (error) { this.sessions.delete(sessionId); throw error; }
  }

  async start(sessionId) {
    const directory = this.directory(sessionId);
    const runtimeFile = join(directory, "runtime.json");
    const filename = join(directory, "architecture.drawio.svg");
    if (existsSync(runtimeFile)) {
      try {
        await verifyDocument(readRuntime(runtimeFile), filename);
        return runtimeFile;
      } catch (error) {
        if (!["drawio_runtime_invalid", "drawio_bridge_unavailable"].includes(error.code)) throw error;
      }
    }
    if (!existsSync(join(this.assetsDir, "index.html"))) {
      throw new BridgeError("drawio_assets_missing", "Install the local draw.io assets under this extension's artifacts/vendor/drawio directory.");
    }
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const child = spawn(this.bun, [join(this.bridgeDir, "server.ts")], {
      cwd: this.bridgeDir,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
        DIAGRAM_FILE: filename, BRIDGE_RUNTIME: runtimeFile, DRAWIO_ASSETS: this.assetsDir, PORT: "0" },
      stdio: "ignore",
    });
    this.children.add(child);
    let failed = false;
    child.once("error", () => { failed = true; this.children.delete(child); });
    child.once("exit", () => this.children.delete(child));
    for (let attempt = 0; attempt < 100 && !failed && child.exitCode === null && child.signalCode === null; attempt++) {
      await sleep(50);
      try {
        const runtime = readRuntime(runtimeFile);
        if (runtime.filename === filename) {
          await verifyDocument(runtime, filename);
          return runtimeFile;
        }
      } catch (error) {
        if (!["drawio_runtime_invalid", "drawio_bridge_unavailable"].includes(error.code)) {
          child.kill("SIGTERM");
          throw error;
        }
      }
    }
    child.kill("SIGTERM");
    throw new BridgeError("drawio_start_failed", "Could not start this session's diagram bridge. Check Bun and the extension's local draw.io assets.");
  }

  stop() {
    for (const child of this.children) child.kill("SIGTERM");
  }
}
