# Draw.io canvas extension

A user-installed Copilot SDK canvas with a local bridge, session-separated editable SVGs and general drawing guidance.

## Setup and use

Save open drawings before installation or upgrades. Install this repository's `drawio-canvas` folder using Copilot's **Install extension from repository** action. The bundled runtime runs inside Copilot's extension process; separate Bun, Node and desktop draw.io installations are not required. First open stages and validates pinned browser assets automatically; valid cached assets and healthy existing bridges are reused. Explicit `DRAWIO_ASSETS` must identify complete compatible local assets; invalid paths do not fall back. If startup reports an incomplete runtime, reinstall the complete folder; for asset preparation failures, check network/cache access, and for drawing storage errors, restore private read/write access. Existing-folder upgrades still require host-managed replacement after saving. Reload only through a supported host action, or restart Copilot after saving.

Open `drawio-architecture` without input to start or reuse the session's bridge. Drawings live under `$COPILOT_HOME/session-state/<sessionId>/files/diagram-bridge/` (`COPILOT_HOME` defaults to `~/.copilot`). New panels and provider restarts retain the drawing; another session starts separately. Explicit `runtimeFile` opens a shared bridge without changing defaults. Reopening that panel without input retains its shared selection until the panel closes; after a provider restart, supply the shared path again if the host has not retained the original input. Session-owned bridges recover from stale-port authentication failures, but document identity mismatches and conflicts remain errors.

The extension appends a short instruction pointing agents to `drawio_get_guidance`, which reads `skills/drawio/SKILL.md` without replacing Copilot's built-in instructions. Canvas actions are `search_shapes`, `read_document` and `apply_operations`. Search returns local styles matched to the served editor assets; it has no online fallback and covers a subset of palettes. Warm searches reuse the parsed index and normalized search fields; filesystem metadata checks detect changed, added or removed assets before reuse.

For complex requests, use meaningful operation batches. Read the document, pass its revision, await rendering and save confirmation, then reread before the next stage. Preserve completed stages on later failure. Reassess conflicts and timeout outcomes rather than blindly retrying. Existing geometry, parents and waypoints remain protected unless the user explicitly permits layout changes.

## Drawing controls

- Edits autosave; the status confirms when they are saved. **Retry save** appears only after saving fails and disappears after a successful save. It retries the current edits in the same editable SVG, not a download or a failed agent operation.
- **SVG preview** opens the saved SVG without editing it.
- **Open in Draw.io** saves first, pauses this canvas and hands off the same file. On macOS it finds draw.io through Launch Services; on Windows it checks PATH and standard install locations; on Linux it checks `drawio` on PATH. If unavailable, it opens the local browser editor, never a hosted service. Allow pop-ups or click **Open browser editor** if needed.
- Close the other editor, then choose **Resume here**. Desktop edits are validated and loaded from the same SVG. An active browser editor blocks resuming; normal close releases ownership immediately, with a 15-second lease timeout if close notification fails (crash/disconnection). The desktop pause survives bridge restarts; closing desktop cannot be detected automatically.

Shape search returns relative image styles usable by both editors. Desktop draw.io supplies its own libraries; old/custom bridge-specific image paths are not rewritten automatically.

## Limits and privacy

- One active editor per drawing; normal browser editor close releases ownership immediately. Allow 15 seconds for lease expiry only if close notification fails (crash/disconnection).
- Closing a panel neither deletes the SVG nor stops the bridge. Provider shutdown closes only services it started in its own process, never another bridge by PID; the drawing remains on disk.
- Runtime credentials stay inside the local provider. Diagram content returned to the agent is processed by Copilot remotely.
- Browser “Download” is not a guaranteed host filesystem location. The bridge's SVG path is the known saved file.
- Keep runtime JSON, drawings, personal configuration and downloaded assets out of shared extension source.

Registration was adapted from the MIT-licensed [official Color Orb extension](https://github.com/github/awesome-copilot/tree/main/extensions/color-orb), using the [Copilot SDK canvas API](https://github.com/github/copilot-sdk/blob/main/nodejs/src/canvas.ts). Keep the supplied license and draw.io's asset notices.
