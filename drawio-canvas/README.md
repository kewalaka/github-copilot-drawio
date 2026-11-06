# Draw.io canvas extension

A user-installed Copilot SDK canvas with a local bridge, session-separated editable SVGs and general drawing guidance.

## Setup and use

Save open drawings before installation. From a complete repository checkout, download the pinned assets as described in the root README, then run `bun run drawio-canvas/install.ts`. This installs the wrapper, bundled bridge, skill and assets together. Wrapper-only folder/gist installs are incomplete. Reload only through a supported host action, or restart Copilot after saving.

Open `drawio-architecture` without input to start or reuse the session's bridge. Drawings live under `$COPILOT_HOME/session-state/<sessionId>/files/diagram-bridge/` (`COPILOT_HOME` defaults to `~/.copilot`). New panels and provider restarts retain the drawing; another session starts separately. Explicit `runtimeFile` opens a shared bridge without changing defaults.

The extension's session hook points agents to `drawio_get_guidance`, which reads `skills/drawio/SKILL.md`. Canvas actions are `search_shapes`, `read_document` and `apply_operations`. Search returns local styles matched to the served editor assets; it has no online fallback and covers a subset of palettes.

For complex requests, use meaningful operation batches. Read the document, pass its revision, await rendering and save confirmation, then reread before the next stage. Preserve completed stages on later failure. Reassess conflicts and timeout outcomes rather than blindly retrying. Existing geometry, parents and waypoints remain protected unless the user explicitly permits layout changes.

## Limits and privacy

- One active editor per drawing; allow 15 seconds after closing another editor for its lease to expire.
- Closing a panel neither deletes the SVG nor stops the bridge. Provider exit stops only bridges it started; the drawing remains on disk.
- Runtime credentials stay inside the local provider. Diagram content returned to the agent is processed by Copilot remotely.
- Browser “Download” is not a guaranteed host filesystem location. The bridge's SVG path is the known saved file.
- Keep runtime JSON, drawings, personal configuration and downloaded assets out of shared extension source.

Registration was adapted from the MIT-licensed [official Color Orb extension](https://github.com/github/awesome-copilot/tree/main/extensions/color-orb), using the [Copilot SDK canvas API](https://github.com/github/copilot-sdk/blob/main/nodejs/src/canvas.ts). Keep the supplied license and draw.io's asset notices.
