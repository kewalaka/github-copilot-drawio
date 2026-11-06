# Draw.io Copilot canvas

Edit local `.drawio.svg` files in GitHub Copilot, with separate drawings per session, revision-checked agent changes and protected manual layout. Includes general draw.io guidance, local shape search and save-confirmed drawing stages.

## Install

Requires Bun and a Copilot host supporting SDK canvas extensions. Save open drawings before replacing an installed extension. From this checkout:

1. Download the pinned draw.io assets using [bridge setup](diagram-bridge/README.md#local-assets).
2. Install dependencies and the complete user extension:

   ```sh
   bun install --cwd diagram-bridge --frozen-lockfile
   bun run drawio-canvas/install.ts
   ```

   The installer copies the wrapper, skill, bridge and matched assets into `$COPILOT_HOME/extensions/drawio-canvas` (`COPILOT_HOME` defaults to `~/.copilot`). It preserves existing artifacts and session drawings. A wrapper-only folder/gist installation is incomplete.
3. Reload extensions through your host's supported extension-management action, or restart Copilot after saving if no reload action is available. Do not reload after an installer failure.
4. Ask Copilot to open `drawio-architecture`, without input. The extension starts or reuses this session's loopback bridge automatically.

## Drawing storage

Default opens create or reopen `$COPILOT_HOME/session-state/<sessionId>/files/diagram-bridge/architecture.drawio.svg`. A new session starts empty; new panels and provider restarts retain that session's drawing. Closing a panel does not delete the file. No remembered global drawing selection is used.

For an explicitly shared drawing, [start a separate bridge](diagram-bridge/README.md#standalone-bridge) and supply its absolute private runtime JSON path as `runtimeFile`. This does not change other sessions' defaults. One editor owns each drawing at a time; close a previous editor and allow 15 seconds for its lease to expire.

The SVG embeds editable XML and rendered images. Browser export's “Download” option is a browser delivery method, not a guaranteed filesystem destination in the host app. Use the bridge's saved SVG for a known local file.

## Agent workflow

The extension announces `drawio_get_guidance` through session context; its tool reads the bundled [general skill](drawio-canvas/skills/drawio/SKILL.md). No separate skill path or remote MCP server is needed.

- `search_shapes` returns exact local styles and size hints, plus the editor version and asset fingerprint. It indexes general palette templates and local SVG libraries, not every stencil/palette shape. No online fallback is used.
- `read_document` supplies the current revision, page IDs and existing layout.
- `apply_operations` waits for rendering and the saved SVG. Build complex requests in meaningful stages, awaiting and checking each save before the next. Completed stages remain saved if a later stage fails. Reread and reassess conflicts or uncertain timeout outcomes; never blindly replay.

Existing positions, parents and user-defined waypoints remain protected. Do not request `relayout: true` without the user's permission. Guidance covers mechanics, not organisation-specific drawing conventions.

## Validate

```sh
bun test drawio-canvas.test.ts drawio-canvas/*.test.ts diagram-bridge/tests/model.test.ts diagram-bridge/tests/shapes.test.ts
bun run --cwd diagram-bridge test:browser
```

Browser tests require the local assets and Playwright Chromium (`bunx playwright install chromium` if missing). Tests use disposable bridges, drawings and installation homes.

Runtime credentials, drawings and downloaded assets are ignored by Git. Diagram content returned to Copilot is processed remotely; credentials stay local. Retain the supplied [MIT attribution](drawio-canvas/LICENSE) and draw.io's asset/license notices.
