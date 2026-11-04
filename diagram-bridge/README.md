# Local architecture editor bridge

A local draw.io editor bridge with a verified user-installed Copilot canvas wrapper. Use Copilot chat to request changes; the bridge has no separate chat or model service.

## Run

Requires Bun and the local draw.io 32.6.9 web assets in `vendor/drawio/`. From this directory, download them before starting or running browser tests:

```sh
mkdir -p vendor
curl --fail --location https://github.com/jgraph/drawio/releases/download/v32.6.9/draw.war -o vendor/draw.war
unzip -q vendor/draw.war -d vendor/drawio
rm vendor/draw.war
```

Retain draw.io's supplied license notices. Assets are intentionally not included in this repository.

```sh
bun install
bun run start
```

Open the loopback URL printed at startup. Manual edits auto-save to `diagrams/architecture.drawio.svg`. The SVG contains both the rendered image, embedded Azure icons and the editable draw.io XML. There is no second source file.

Choose a persistent file outside the checkout when needed:

```sh
DIAGRAM_FILE=/absolute/path/design.drawio.svg bun run start
```

An existing embedded-XML SVG is reopened. Only one browser editor owns a file at a time. Runtime credentials in `runtime.json` are private; do not share that file. Stop the server with Ctrl+C when running it in a terminal.

The initial diagram is an illustrative Azure integration design, not an Azure resource discovery result. It distinguishes resource-group ownership from subnet placement, and resource relationships from network and application/data flows. Labels state intentionally omitted networking details.

## Copilot canvas

Install the `drawio-canvas` user extension as described in the [repository README](../README.md#start-and-install). Start the bridge, then open `drawio-architecture` once with `runtimeFile` set to the absolute path of its private runtime JSON. Subsequent opens can omit input. Close any previous editor for the same diagram and wait 15 seconds for its lease to expire.

Use the canvas's `read_document` action before `apply_operations`, passing the revision just read as `expectedRevision`. The wrapper waits for a saved SVG and reports stale revisions without blindly retrying. Reopen the canvas after a bridge restart to load its new URL. The extension is installed persistently; the bridge must still be started separately.

## Agent changes

The command-line interface remains available. Read the current document and stable component IDs:

```sh
bun run agent.ts
```

Put requested operations in a temporary JSON file, then apply them:

```sh
bun run agent.ts /absolute/path/operations.json
```

Example input:

```json
{
  "operations": [
    { "kind": "update", "id": "function", "label": "Event ingestion processor" },
    {
      "kind": "add", "id": "monitor", "parent": "rg-app",
      "label": "Application Insights",
      "geometry": { "x": 620, "y": 82, "width": 120, "height": 70 }
    }
  ]
}
```

`add`, `update` and `remove` operate on stable IDs. New nodes need geometry. New connectors need `source`, `target`, a `label` and a `relation`: `relationship`, `network` or `data`. Remove connections and children before their parent. `pageId` selects a page; otherwise the first is used.

Existing positions and parents cannot change unless the request explicitly includes `"relayout": true`. Do not set that flag without the user requesting rearrangement. Read the latest diagram before deciding placement; expand explicitly named focal components rather than all dependencies.

The agent command retries stale revisions after re-reading. The editor briefly blocks input during export/save. The SVG is validated and atomically replaced only after successful rendering. Updates cannot silently overwrite a detected external file change; resolve it and restart. Unsaved drafts are kept in memory, not crash-recovery storage.

## Privacy and limits

The server binds only to `127.0.0.1`. Editor assets are local; browser policy blocks external asset and API requests. SVG images are embedded and external links are disabled on save. Export uses the browser, not a remote export server. Copilot’s own agent processing is still remote.

This is a single-user bridge, not simultaneous collaboration. The SVG’s visual preview uses the current page; editable XML retains all pages. Native canvas discovery, opening, revision-checked saves and input validation were verified using the installed wrapper.

## Validate

```sh
bun test tests/model.test.ts
bunx playwright test
```

Browser tests run isolated servers and disposable diagrams. They exercise real dragging, agent changes, embedded SVG reopen, conflicts and local-only requests.

Downloaded assets, runtime credentials and generated diagrams are ignored by Git.
