# Local draw.io bridge

Serves the editor, authenticated document/shape APIs and revision-checked SVG saves. The installed canvas normally starts one bridge per session; a standalone bridge is optional for explicitly shared drawings.

## Local assets

From this directory, download the pinned draw.io **32.6.9** web assets before installation or browser tests:

```sh
mkdir -p vendor
curl --fail --location https://github.com/jgraph/drawio/releases/download/v32.6.9/draw.war -o vendor/draw.war
unzip -q vendor/draw.war -d vendor/drawio
rm vendor/draw.war
```

Assets are intentionally not committed. Retain their license notices; artwork and stencils can have separate terms from application code. The source is draw.io tag `v32.6.9` (commit `3e707fd20b6930778d6f6bf6e4d0079b4bce366b`).

`DRAWIO_ASSETS` can select another local asset directory. Shape lookup uses that same directory served at `/drawio/`, rejects a different editor version, and fingerprints its palette/image contents. It extracts literal general palette templates and local SVG libraries without executing palette code or following symlinks. Coverage is deliberately smaller than the full stencil catalog. There is no online icon fallback or copied upstream MCP index.

## Standalone bridge

```sh
bun install --frozen-lockfile
DIAGRAM_FILE="$PWD/diagrams/design.drawio.svg" BRIDGE_RUNTIME="$PWD/runtime.json" bun run start
```

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
