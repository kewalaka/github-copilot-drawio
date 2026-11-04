# Draw.io Copilot canvas

Edit one local `.drawio.svg` in GitHub Copilot with revision-checked agent changes and protected manual layout. The bridge serves the editor locally; the user-installed extension connects Copilot to it.

## Start and install

Requires Bun, GitHub Copilot with canvas extensions, and local draw.io assets.

1. Clone this private repository and follow [bridge setup](diagram-bridge/README.md#run) to download the pinned editor assets.
2. Start the bridge:

   ```sh
   cd diagram-bridge
   bun install --frozen-lockfile
   bun run start
   ```

   To keep a drawing elsewhere, set `DIAGRAM_FILE` to its absolute `.drawio.svg` path. Set `BRIDGE_RUNTIME` to choose the private runtime JSON location.
3. Ask Copilot to install the user extension from `https://github.com/kewalaka/ghcp-canvas-drawio/tree/main/drawio-canvas`.
4. Close any other editor for this drawing and wait 15 seconds for its lease to expire. Open `drawio-architecture` once with `runtimeFile` set to the bridge's absolute runtime JSON path. Never paste that file's contents into chat.

## Reopen and edit

Later opens need no input, including fresh panels and extension restarts. The extension remembers only the runtime path and drawing identity in `$COPILOT_HOME/extensions/drawio-canvas/artifacts/last-bridge.json` (`COPILOT_HOME` defaults to `~/.copilot`). It rereads credentials and the loopback URL from the private runtime file. Start the bridge separately and reopen after restarting it.

To select another drawing or repair a stale selection, supply `runtimeFile` explicitly. Delete `last-bridge.json` to forget the selection. A changed drawing identity is rejected on default opens rather than silently switching files.

Read with `read_document` before `apply_operations`, passing the returned revision as `expectedRevision`. Existing positions and parents stay protected unless the user explicitly requests `relayout: true`. See [operation guidance](diagram-bridge/README.md#agent-changes).

Runtime files, user preferences, drawings and downloaded assets are ignored by Git. Diagram content returned to Copilot is processed remotely; credentials stay local. Keep the supplied [MIT attribution](drawio-canvas/LICENSE) and draw.io's license notices.

## Validate

From the repository root, after installing bridge dependencies:

```sh
bun test drawio-canvas.test.ts diagram-bridge/tests/model.test.ts
cd diagram-bridge
bun run test:browser
```

Browser tests require the local editor assets and Playwright Chromium (`bunx playwright install chromium` if missing). Tests use disposable bridges, drawings and preference directories, not the live editor.
