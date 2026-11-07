import { accessSync, constants, existsSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readRuntime, request, BridgeError } from "./bridge.mjs";

const extensionDir = dirname(fileURLToPath(import.meta.url));
const repairInstallation = "Install this repository's complete drawio-canvas folder using Copilot's Install extension from repository action, then restart Copilot after saving open drawings.";
const storageError = () => new BridgeError("drawio_storage_unavailable", "This session's drawing storage is inaccessible or a drawing/runtime path is not a regular file. Check COPILOT_HOME and the session's files/diagram-bridge directory; restore read/write access without making private files public, then reopen the canvas. Existing drawings have not been replaced.");
const stoppedError = () => new BridgeError("drawio_bridge_unavailable", "This diagram provider is shutting down. Reopen the canvas after Copilot restarts.");

function readableFile(filename) {
  if (!statSync(filename).isFile()) throw new Error();
  accessSync(filename, constants.R_OK);
}

async function verifyDocument(runtime, filename) {
  if (runtime.filename !== filename || (await request(runtime, "document")).filename !== filename) {
    throw new BridgeError("drawio_document_changed", "This session's bridge points to another drawing. Check its private runtime configuration before reopening.");
  }
}

export class SessionBridges {
  constructor({ home = process.env.COPILOT_HOME || join(homedir(), ".copilot"),
    runtimePath = join(extensionDir, "runtime.mjs"), assetsDir = join(extensionDir, "artifacts", "vendor", "drawio"),
    sourceAssets = process.env.DRAWIO_ASSETS, loadRuntime } = {}) {
    this.home = home;
    this.runtimePath = runtimePath;
    this.assetsDir = assetsDir;
    this.sourceAssets = sourceAssets;
    this.loadRuntime = loadRuntime;
    this.sessions = new Map();
    this.services = new Map();
    this.stopping = false;
  }

  directory(sessionId) {
    if (typeof sessionId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(sessionId)) {
      throw new BridgeError("drawio_session_invalid", "A valid session ID is required for separate diagram storage.");
    }
    if (typeof this.home !== "string" || !isAbsolute(this.home)) throw storageError();
    return join(this.home, "session-state", sessionId, "files", "diagram-bridge");
  }

  async runtimeFile(sessionId) {
    if (this.stopping) throw stoppedError();
    let pending = this.sessions.get(sessionId);
    if (!pending) {
      pending = this.start(sessionId);
      this.sessions.set(sessionId, pending);
    }
    try { return await pending; }
    finally { if (this.sessions.get(sessionId) === pending) this.sessions.delete(sessionId); }
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
        if (!["drawio_runtime_invalid", "drawio_bridge_unavailable"].includes(error.code) &&
            !(error instanceof BridgeError && error.status === 401)) throw error;
      }
    }
    let runtime;
    try {
      if (this.loadRuntime) runtime = await this.loadRuntime();
      else {
        if (typeof this.runtimePath !== "string" || !isAbsolute(this.runtimePath)) throw new Error();
        readableFile(this.runtimePath);
        runtime = await import(pathToFileURL(this.runtimePath).href);
      }
      if (typeof runtime.startBridge !== "function" || typeof runtime.ensureAssets !== "function") throw new Error();
    } catch {
      throw new BridgeError("drawio_install_incomplete", `The bundled diagram runtime is missing, unreadable or incomplete. Check the configured runtime file; wrapper-only installs are incomplete. ${repairInstallation}`);
    }
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      accessSync(directory, constants.R_OK | constants.W_OK | constants.X_OK);
      for (const file of [filename, runtimeFile]) {
        if (existsSync(file)) {
          readableFile(file);
          accessSync(file, constants.W_OK);
        }
      }
    } catch { throw storageError(); }
    let assets;
    try {
      if (typeof this.assetsDir !== "string" || !isAbsolute(this.assetsDir)) throw new Error();
      const pending = this.assetsPending ||= runtime.ensureAssets({ destination: this.assetsDir, assets: this.sourceAssets });
      try { assets = await pending; }
      finally { if (this.assetsPending === pending) this.assetsPending = undefined; }
      if (typeof assets !== "string" || !isAbsolute(assets)) throw new Error();
      readableFile(join(assets, "index.html"));
    } catch {
      throw new BridgeError("drawio_assets_unavailable", "Could not prepare the pinned browser draw.io assets. Check network access and private asset-cache read/write permissions, or correct explicit DRAWIO_ASSETS to a complete compatible local asset directory, then reopen the canvas. Desktop draw.io is optional and cannot replace browser assets.");
    }
    if (this.stopping) throw stoppedError();
    const previous = this.services.get(sessionId);
    if (previous) {
      await previous.close();
      this.services.delete(sessionId);
    }
    let service;
    try {
      service = await runtime.startBridge({ filename, runtimeFile, assets, port: 0 });
      if (typeof service?.close !== "function") throw new Error();
      const config = readRuntime(runtimeFile);
      if (config.url !== service.url) throw new Error();
      await verifyDocument(config, filename);
      this.services.set(sessionId, service);
      return runtimeFile;
    } catch (error) {
      if (service?.close) await service.close();
      if (error.code === "drawio_document_changed") throw error;
      throw new BridgeError("drawio_start_failed", `Could not start this session's diagram bridge. Check private drawing storage access and repair the bundled runtime installation. ${repairInstallation}`);
    }
  }

  stop() {
    this.stopping = true;
    return this.stopPending ||= (async () => {
      await Promise.allSettled(this.sessions.values());
      const services = [...this.services.values()];
      this.services.clear();
      await Promise.all(services.map(service => service.close()));
    })();
  }
}
