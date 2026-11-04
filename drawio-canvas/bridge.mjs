import { readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

export class BridgeError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function readRuntime(runtimeFile) {
  try {
    if (!isAbsolute(runtimeFile) || !statSync(runtimeFile).isFile() || statSync(runtimeFile).size > 4096) throw new Error();
    const runtime = JSON.parse(readFileSync(runtimeFile, "utf8"));
    if (!/^http:\/\/127\.0\.0\.1:[0-9]+\/?$/.test(runtime.url) ||
        !/^[a-f0-9]{64}$/.test(runtime.token) ||
        typeof runtime.filename !== "string" || !isAbsolute(runtime.filename) || !runtime.filename.endsWith(".drawio.svg")) throw new Error();
    const url = new URL(runtime.url);
    if (!url.port) throw new Error();
    return { url: url.origin, token: runtime.token, filename: runtime.filename };
  } catch {
    throw new BridgeError("drawio_runtime_invalid", "Provide an absolute path to the running local diagram bridge's runtime JSON file.");
  }
}

export async function request(runtime, endpoint, body) {
  let response;
  try {
    response = await fetch(`${runtime.url}/api/${endpoint}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${runtime.token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    throw new BridgeError("drawio_bridge_unavailable", "The local diagram bridge is unreachable. Start it, then reopen the canvas.");
  }
  let result;
  try { result = await response.json(); }
  catch { throw new BridgeError("drawio_response_invalid", "The local diagram bridge returned an invalid response."); }
  if (!response.ok) {
    const message = typeof result.error === "string" ? result.error.replaceAll(runtime.token, "[redacted]") : "Diagram bridge request failed.";
    throw new BridgeError(response.status === 409 ? "drawio_conflict" : "drawio_request_failed", message);
  }
  return result;
}

export async function applyOperations(runtime, input) {
  const { id } = await request(runtime, "operations", input);
  if (typeof id !== "string" || !/^[a-f0-9]{24}$/.test(id)) throw new BridgeError("drawio_response_invalid", "The local diagram bridge returned an invalid job identifier.");
  const deadline = Date.now() + 35000;
  while (Date.now() < deadline) {
    await sleep(200);
    const job = await request(runtime, `jobs/${id}`);
    if (job.status === "completed") return job.result;
    if (job.status === "failed") throw new BridgeError("drawio_update_failed", String(job.error ?? "Diagram update failed.").replaceAll(runtime.token, "[redacted]"));
  }
  throw new BridgeError("drawio_update_timeout", "The editor did not confirm the save. Read the document before retrying; do not assume the update was rolled back.");
}
