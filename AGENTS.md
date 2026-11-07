# Engineering guidance

- Run development commands from the repository root with Bun. Production runs in Copilot-managed Node; keep the host-provided `@github/copilot-sdk/extension` external and stdout reserved for SDK JSON-RPC.
- Edit `diagram-bridge/` sources and `drawio-canvas/` wrappers, not generated `drawio-canvas/runtime.mjs` or `build-manifest.json`. After changing recorded build inputs, regenerate both with `bun run drawio-canvas/build.ts`.
- Unit tests: `bun test drawio-canvas.test.ts drawio-canvas/*.test.ts diagram-bridge/tests/*.test.ts`. Browser tests: `bun run --cwd diagram-bridge test:browser` (local assets and Playwright Chromium required). Use disposable drawings, runtime files and installation homes; never use a live user's diagram as a fixture or run the installer against their home as a test.
- Preserve document identity, revision/disk-conflict checks, all SVG pages and save-confirmed batches. Discover actual page root/layer IDs. Protect existing geometry, parents and waypoints; `relayout` requires explicit user permission. A failed stage must not undo earlier saved stages.
- Keep API authentication, loopback-only URLs, credential redaction and single-editor ownership intact. Do not stop external bridges by PID or treat recovery failures as permission to overwrite drawings.
- Do not commit runtime JSON, user configuration, drawings, downloaded assets, dependencies or test output. Retain MIT and third-party notices.

See [DESIGN.md](DESIGN.md) for lifecycle, build boundaries, asset preparation and manual upgrades.
