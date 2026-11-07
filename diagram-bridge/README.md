# Local draw.io bridge

Serves the editor, authenticated document/shape APIs and revision-checked SVG saves. The installed canvas normally starts one bridge per session; a standalone bridge is optional for explicitly shared drawings.

## Local assets

Install the `drawio-canvas` folder through Copilot's **Install extension from repository** action; see the [installation and manual-upgrade instructions](../README.md#install). Copilot imports the supplied `runtime.mjs` in its managed Node process, with the XML dependency and frontend already bundled. End users do not need Bun, standalone Node or a package-install step.

On first open, missing assets are prepared from the pinned draw.io **32.6.9** web archive using Node's streaming download, `unzip` on macOS/Linux or Windows PowerShell/.NET ZIP extraction. This requires public upstream network access and the applicable OS extractor, not runtime GitHub credentials or a hosted editor. Valid local/prepared assets are reused. The archive's pinned size/SHA-256 and safe ZIP paths are checked before extraction; every extracted entry and required editor/shape resource is checked before a prepared directory is published. Explicit incompatible `DRAWIO_ASSETS` selections fail without fallback.

Concurrent preparation uses a destination lock and adjacent staging. Caught publication failures restore previous assets without modifying private settings or session drawings. Replacement is two directory renames, not crash-atomic; interruption leaves recovery files/locks for inspection rather than silently deleting them. Manual implementation upgrades likewise publish selected files individually with rollback, not a whole-extension atomic swap. Save drawings first; reload/restart is a deliberate user action after success, never an installer action. The native install action cannot currently replace an existing folder.

The official source is [jgraph/drawio release v32.6.9](https://github.com/jgraph/drawio/releases/tag/v32.6.9), asset `draw.war` (49,701,599 bytes). Its [published GitHub release metadata](https://api.github.com/repos/jgraph/drawio/releases/tags/v32.6.9) supplies SHA-256 `31afc82b7920c409d0591f6126ccb6c377d7800e7f11ab324f88bdf1e4249ce7`, pinned in the installer. Installation does not query releases or select a newer version.

For standalone development or browser tests, prepare checkout assets from the repository root (Bun is development-only):

```sh
bun install --cwd diagram-bridge --frozen-lockfile
bun run drawio-canvas/build.ts
bun -e 'import { ensureAssets } from "./drawio-canvas/runtime.mjs"; await ensureAssets({destination: "diagram-bridge/vendor/drawio", assets: process.env.DRAWIO_ASSETS})'
```

Do not merge a newer archive over old assets. Assets are intentionally not committed. Retain their license notices; artwork and stencils can have separate terms from application code. The source is draw.io tag `v32.6.9` (commit `3e707fd20b6930778d6f6bf6e4d0079b4bce366b`).

`DRAWIO_ASSETS` can select another local asset directory. Shape lookup uses that same directory served at `/drawio/`, rejects a different editor version, and fingerprints its palette/image contents. It extracts literal general palette templates and local SVG libraries without executing palette code or following symlinks. Coverage is deliberately smaller than the full stencil catalog. There is no online icon fallback or copied upstream MCP index.

## Standalone bridge

From the repository root, after preparing assets:

```sh
DIAGRAM_FILE="$PWD/diagrams/design.drawio.svg" BRIDGE_RUNTIME="$PWD/diagrams/runtime.json" bun run --cwd diagram-bridge start
```

The development `start.ts` entry calls the pure server factory and prints only its loopback URL, never credentials. Defaults are module-relative: `diagram-bridge/diagrams/architecture.drawio.svg`, `diagram-bridge/runtime.json`, and `diagram-bridge/vendor/drawio` (or adjacent `artifacts/vendor/drawio` if the checkout assets are absent). `DIAGRAM_FILE`, `BRIDGE_RUNTIME` and `DRAWIO_ASSETS` override these paths; `PORT` defaults to `0` for an available port. This source entry does not download assets. Ctrl+C or SIGTERM closes its own bridge.

Open the printed loopback URL, or pass the absolute runtime JSON path as the canvas's `runtimeFile`. Keep runtime contents private. An existing editable SVG is reopened; a missing drawing starts empty and is saved by the editor. Manual edits auto-save. Stop a terminal-run bridge with Ctrl+C.

Only one editor owns each drawing. Close any other editor and wait 15 seconds for its lease to expire. The SVG stores the rendered preview, embedded images and editable XML for all pages; there is no separate XML source file.

## Operations and persistence

Use the [general skill](../drawio-canvas/skills/drawio/SKILL.md) and canvas actions for interactive drawing. `apply_operations` accepts `expectedRevision`, optional `pageId`, `operations`, and user-approved `relayout`. New nodes need stable IDs and geometry; connectors need endpoints, a label and `relationship`, `network` or `data`. Remove connections/children before parents. Page root/layer IDs are discovered structurally, not assumed to be `0`/`1`.

Each batch queues an editor job, renders an editable SVG, validates it and atomically saves it before reporting completion. Use meaningful stages and reassess conflicts before continuing. Earlier saved stages remain intact on later failures. Existing positions, parents and user-defined waypoints are preserved without authorised layout changes. XML whitespace and attribute order do not count as edits; page settings, cell order and geometry still do.

External disk changes are detected, not silently overwritten. Unsaved drafts are in memory, not crash-recovery storage. Keep the editor open if a manual save fails; the saved SVG may not contain the rejected draft. Browser “Download” depends on host delivery and is not a reliable local backup path.

The diagnostic CLI `bun run agent.ts` reads the selected runtime's document. Its file-based write mode retries stale revisions automatically; prefer canvas actions when changes require interactive reassessment.

## Privacy and validation

The server binds to `127.0.0.1`, serves assets locally and blocks external browser requests. Saved SVGs embed images and reject active content/external asset references. Diagram content returned to Copilot is still processed remotely.

```sh
bun test tests/model.test.ts tests/shapes.test.ts
bun run test:browser
```

Tests use isolated servers and disposable drawings. Runtime credentials, drawings and downloaded assets are ignored by Git.
