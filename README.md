# Draw.io Copilot canvas

Edit local `.drawio.svg` files in GitHub Copilot, with separate drawings per session, revision-checked agent changes and protected manual layout. Includes general draw.io guidance, local shape search and save-confirmed drawing stages.

## Install

Use Copilot's **Install extension from repository** action and select this repository's `drawio-canvas` folder. The host must support SDK canvas extensions and have access to this private repository. No end-user Bun, standalone Node, package install or compilation is required: the folder includes a prebuilt ordinary-Node `runtime.mjs`, its bundled XML dependency and the frontend. Copilot runs it inside its managed extension process; it does not launch another Node executable.

Then ask Copilot to open `drawio-architecture`, without input. On first open, the extension acquires missing draw.io **32.6.9** assets from the [official pinned archive](diagram-bridge/README.md#local-assets). This public download needs network access, but no runtime GitHub credentials. Extraction uses `unzip` on macOS/Linux, or Windows PowerShell's built-in .NET ZIP support on Windows. Valid prepared assets are reused without downloading; the editor itself is served locally, not from a hosted editor.

`DRAWIO_ASSETS=/absolute/path` explicitly selects local assets. A missing, incomplete or incompatible explicit selection fails rather than downloading a replacement. Downloaded archives must match the pinned size and published SHA-256 and pass ZIP/extraction checks. Local extracted directories are checked for the editor version, required resources and shape-index compatibility, not authenticated against the original archive. Preparation uses adjacent staging and a lock and never modifies private settings or session drawings.

**Upgrades are manual.** The host's repository-install action currently refuses an existing extension folder; do not treat it as an automatic or one-step upgrade. Save drawings and stop using the extension before replacing implementation. No installer requests a live reload: after successful replacement, deliberately reload using a supported host action or restart Copilot. Do not reload after failure.

### Development build and manual upgrade

From a complete development checkout with Bun and the pinned development dependency available:

```sh
bun install --cwd diagram-bridge --frozen-lockfile
bun run drawio-canvas/build.ts
bun run drawio-canvas/install.ts
```

The last command also supports manual upgrades from a checkout you obtain yourself. It stages the wrapper, skill, prebuilt runtime, notices and assets in `$COPILOT_HOME/extensions/` (`COPILOT_HOME` defaults to `~/.copilot`). Valid checkout or previously installed assets are reused before downloading. Runtime checksum, bundled dependency metadata, runtime exports, wrapper build, manifest and assets are validated before publication. Production does not install packages. Build-sync tests require regenerated runtime output whenever its recorded source/public/build inputs change; the generated bundle is source-distributed so private-repository installation needs no runtime repository access.

The development installer replaces selected implementation files **one at a time**, keeping private artifacts in place and replacing only `artifacts/vendor/drawio`. Caught publication failures roll back old implementation and assets; session drawings are never replaced. This is not crash-atomic publication of a complete extension directory. Asset preparation similarly uses a complete prepared directory but replacing old assets takes two renames, not a single crash-atomic swap. An abrupt interruption can leave mixed implementation or a missing asset destination, with lock/staging backups retained. Inspect these before retrying; rollback failures report the retained recovery directory. Neither path fetches Git updates, starts live bridges or reloads the host.

## Drawing storage

Default opens create or reopen `$COPILOT_HOME/session-state/<sessionId>/files/diagram-bridge/architecture.drawio.svg`. A new session starts empty; new panels and provider restarts retain that session's drawing. Closing a panel does not delete the file. No remembered global drawing selection is used.

For an explicitly shared drawing, [start a separate bridge](diagram-bridge/README.md#standalone-bridge) and supply its absolute private runtime JSON path as `runtimeFile`. This does not change other sessions' defaults. One editor owns each drawing at a time. Normal browser close releases ownership immediately; the 15-second lease expiry is a fallback for crashes or disconnections.

The SVG embeds editable XML and rendered images. Browser export's “Download” option is a browser delivery method, not a guaranteed filesystem destination in the host app. Use the bridge's saved SVG for a known local file.

## Agent workflow

The extension announces `drawio_get_guidance` through session context; its tool reads the bundled [general skill](drawio-canvas/skills/drawio/SKILL.md). No separate skill path or remote MCP server is needed.

- `search_shapes` returns exact local styles and size hints, plus the editor version and asset fingerprint. It indexes general palette templates and local SVG libraries, not every stencil/palette shape. No online fallback is used.
- `read_document` supplies the current revision, page IDs and existing layout.
- `apply_operations` waits for rendering and the saved SVG. Build complex requests in meaningful stages, awaiting and checking each save before the next. Completed stages remain saved if a later stage fails. Reread and reassess conflicts or uncertain timeout outcomes; never blindly replay.

Existing positions, parents and user-defined waypoints remain protected. Do not request `relayout: true` without the user's permission. Guidance covers mechanics, not organisation-specific drawing conventions.

## Validate

```sh
bun test drawio-canvas.test.ts drawio-canvas/*.test.ts diagram-bridge/tests/*.test.ts
bun run --cwd diagram-bridge test:browser
```

Browser tests require the local assets and Playwright Chromium (`bunx playwright install chromium` if missing). Tests use disposable bridges, drawings and installation homes.

Runtime credentials, drawings and downloaded assets are ignored by Git. Diagram content returned to Copilot is processed remotely; credentials stay local. Retain the supplied [MIT attribution](drawio-canvas/LICENSE) and draw.io's asset/license notices.
