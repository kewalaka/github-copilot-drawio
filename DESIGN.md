# Design and development

## Architecture and lifecycle

The `drawio-architecture` canvas runs a loopback drawing bridge inside Copilot's managed extension process. End users do not need Bun, a separate Node executable or compilation. Install scope controls availability: a user installation can serve sessions across the app; a session installation is limited to that session. A compatible host and repository access are required; this is not a hosted multiplayer service.

| Source | Responsibility |
| --- | --- |
| `drawio-canvas/extension.mjs`, `canvas.mjs`, `bridge.mjs`, `session-bridge.mjs` | SDK registration, canvas actions, credential-safe requests and session bridge lifecycle. |
| `diagram-bridge/server.ts`, `model.ts`, `shapes.ts`, `desktop.ts`, `public/` | HTTP admission, document validation, shape lookup, desktop launch and editor UI. |
| `drawio-canvas/build.ts`, `runtime-entry.ts`, `runtime.mjs`, `build-manifest.json` | Build and distribute an ordinary-Node runtime containing the frontend and pinned XML dependency. |

Default opens create or reopen `$COPILOT_HOME/session-state/<sessionId>/files/diagram-bridge/architecture.drawio.svg`; `COPILOT_HOME` defaults to `~/.copilot`. A new session starts empty. New panels and provider restarts retain its saved drawing. Closing a panel removes its binding, not the drawing or bridge. Provider shutdown closes only services it started, never another process by PID.

For an explicitly shared drawing, [start a standalone bridge](diagram-bridge/README.md#standalone-bridge) and pass its absolute private runtime JSON path as `runtimeFile`. Other sessions' defaults do not change. Reopening the same panel without input retains its shared selection until close; after provider restart, supply the shared path again if the host has not retained the original input. No remembered global drawing selection is used.

Session-owned bridges can restart after unavailability or stale-port authentication failure. Document identity mismatches and conflicts remain errors, not permission to switch drawings or overwrite files.

## Editing, saving and export

- Manual edits autosave to an editable `.drawio.svg`, with rendered images and embedded XML for all pages. The status confirms persistence; there is no separate XML source file.
- **Retry save** appears only after a manual save fails and disappears after successful persistence. It retries current edits, not a failed agent operation or a download. Keep the editor open after failure: unsaved drafts are in memory, not crash-recovery storage.
- Agent batches render and validate an SVG before replacing the saved file by a temporary-file rename. Failed batches restore the prior live diagram and release the save lock; earlier completed stages remain saved. This recovery is not persistent undo history: the extension exposes no undo action or guarantee that successful agent updates can be undone across reloads.
- External disk changes are detected rather than silently overwritten. Revision checks also reject stale agent updates. Resolve the conflict and reread before continuing.
- **SVG preview** opens the saved SVG without editing it. Browser export/download depends on host delivery and is not a guaranteed local backup path; the bridge's saved SVG is the known file.

## Open in Draw.io and editor ownership

**Open in Draw.io** saves first, pauses the canvas and hands off the same file. On macOS, desktop discovery uses Launch Services; Windows checks PATH and standard install locations; Linux checks `drawio` on PATH. If desktop draw.io is unavailable, handoff opens the local browser editor, never a hosted service. Allow pop-ups or click **Open browser editor** if necessary.

Close the other editor, then choose **Resume here**. Desktop changes are validated and loaded from the same SVG. The desktop pause survives bridge restarts; desktop closure cannot be detected automatically. An active browser editor blocks resuming. Normal browser close releases ownership immediately; the 15-second lease expiry is only a crash/disconnection fallback. There is one active editor per drawing, not simultaneous human editing in multiple panels.

Shape search returns relative image styles usable by both editors. Desktop draw.io supplies its own libraries; older/custom bridge-specific image paths are not rewritten automatically.

## Agent workflow

The extension appends a short instruction pointing agents to `drawio_get_guidance`, which reads the bundled [general drawing skill](drawio-canvas/skills/drawio/SKILL.md) without replacing Copilot's built-in instructions. No separate skill installation or remote MCP server is needed.

1. `search_shapes` returns exact local styles, size hints, editor version and asset fingerprint. It covers literal general palette templates and local SVG libraries, not the entire stencil catalog. There is no online fallback or palette-code execution. Warm searches reuse the parsed index and normalized search fields; filesystem metadata checks detect changed, added or removed assets.
2. `read_document` supplies revision, page IDs and layout. Root/layer IDs are discovered structurally rather than assumed to be `0` and `1`.
3. `apply_operations` accepts `expectedRevision`, optional `pageId`, `operations` and user-approved `relayout`. Existing positions, parents and user-defined waypoints stay protected unless layout changes are explicitly allowed. Build meaningful batches, await rendering and save confirmation, then reread before the next stage. Reassess conflicts and uncertain timeout outcomes rather than blindly replaying.

Guidance covers drawing mechanics, not organisation-specific conventions. The optional [diagnostic CLI](diagram-bridge/README.md#operations-and-persistence) has automatic stale-revision retries in file-based write mode; prefer canvas actions for interactive reassessment.

## Privacy boundaries

The editor, saved files, shape search and bridge run locally. The bridge binds to `127.0.0.1`, checks Host, authenticates API requests and checks Origin before buffering request bodies. Authenticated uploads retain the 24 MB cap. Saved SVGs embed images and reject active content and external asset references.

This does **not** mean model processing is local: diagram content returned to the agent is processed remotely by Copilot. Runtime credentials remain local and are redacted from request errors. Keep runtime JSON, drawings, personal configuration, dependencies, downloaded assets and test output out of shared extension source and commits.

Retain the [supplied MIT attribution](drawio-canvas/LICENSE) and [third-party notices](drawio-canvas/THIRD_PARTY_NOTICES.txt). Registration was adapted from the [official Color Orb extension](https://github.com/github/awesome-copilot/tree/main/extensions/color-orb). Draw.io artwork and stencils may have separate terms from application code; keep their asset notices.

## Installation and upgrades

The [app installation steps](README.md#install) install the complete source-distributed `drawio-canvas` folder, including its prebuilt runtime, XML dependency and frontend. Wrapper-only installs are incomplete. Editing does not require runtime repository access after installation.

First open prepares missing browser assets from the pinned draw.io **32.6.9** [official archive](diagram-bridge/README.md#local-assets). This needs upstream network access and `unzip` on macOS/Linux or Windows PowerShell/.NET ZIP extraction. Valid prepared assets are reused without downloading. `DRAWIO_ASSETS=/absolute/path` explicitly selects complete compatible local assets; a missing or incompatible selection fails without fallback. Desktop draw.io cannot replace these browser assets.

Downloads must match the pinned size and published SHA-256 and pass ZIP/extraction checks. Extracted local directories are checked for editor version, required resources and shape-index compatibility, not authenticated against the original archive. Preparation uses adjacent staging and locks without replacing private settings or session drawings.

For an incomplete runtime, reinstall the complete folder. For asset failures, check network/cache access and any explicit asset path. For storage failures, restore private read/write access rather than making files public.

The small version beneath **Architecture editor** comes from `drawio-canvas/version.txt`, read at bridge startup, independently of the manifest's format version and the pinned draw.io version. On open and **Check updates**, the bridge queries GitHub's public tags API anonymously: no `gh` CLI, GitHub credentials, diagram content or local paths are sent. It compares stable `vMAJOR.MINOR.PATCH` tags numerically, skipping prereleases and unrelated tags. Successful checks are cached per bridge for one hour; failures for five minutes. Requests time out after five seconds and scan at most five pages of 100 tags. Private repositories, rate limits, offline access and incomplete checks report **Check unavailable** without blocking editing or changing save status. The available-version link opens that tag's installable folder; it does not install anything.

Release Please runs on pushes to `main` (or a manual workflow run). Conventional commits drive subsequent versions and the generated root `CHANGELOG.md`; merging its release PR creates a `v…` tag and GitHub release. `version.txt` ships directly, so version-only release PRs do not require regenerating the runtime.

**Upgrades are manual.** The app installer currently refuses an existing extension folder. Save drawings and stop using the extension before replacing implementation. After success, deliberately reload through a supported host action or restart Copilot; do not reload after failure. Neither installer fetches Git updates, starts live bridges or reloads the host.

The development installer stages wrapper, skill, runtime, notices and assets under `$COPILOT_HOME/extensions/`. It validates runtime checksum, dependency metadata, exports, wrapper build, manifest and assets, then replaces selected implementation files one at a time and the managed `artifacts/vendor/drawio` subtree. Private artifacts remain in place; session drawings are not replaced.

Caught publication failures roll back implementation and assets. This is not whole-extension crash-atomic publication; asset replacement also takes two directory renames. Abrupt interruption can leave mixed implementation, a missing asset destination or retained lock/staging backups. Inspect recovery files before retrying; rollback failures report the retained recovery directory. Windows extraction is command-tested, not end-to-end Windows tested.

## Development and validation

Run commands from the repository root. Bun is development tooling; the shipped runtime targets ordinary Node. Dependencies are pinned in `diagram-bridge/package.json` and `bun.lock` (`@xmldom/xmldom` 0.9.12, Playwright 1.64.1).

```sh
bun install --cwd diagram-bridge --frozen-lockfile
bun run drawio-canvas/build.ts
bun test drawio-canvas.test.ts drawio-canvas/*.test.ts diagram-bridge/tests/*.test.ts
bun run --cwd diagram-bridge test:browser
```

Use an existing dependency installation when available. Browser tests require [prepared local assets](diagram-bridge/README.md#local-assets) and Playwright Chromium; install Chromium only if missing (`cd diagram-bridge && bunx playwright install chromium`). Tests use disposable bridges, drawings and installation homes; browser tests run the production bundle under ordinary Node.

`runtime.mjs` and `build-manifest.json` are generated distributable code and hashes, not disposable test output. Edit their recorded source inputs, then regenerate both with `build.ts`; build-sync tests check exact freshness. Wrapper `.mjs` files and the bundled skill ship directly. Do not copy vendor assets or `node_modules` into the distributable.

For a deliberate user-level install or manual upgrade from a complete checkout:

```sh
bun run drawio-canvas/install.ts
```

This writes the user's installation; it is not a routine validation command. Use a disposable `COPILOT_HOME` for installation tests. See [AGENTS.md](AGENTS.md) for concise engineering invariants and the [bridge README](diagram-bridge/README.md#standalone-bridge) for optional standalone startup.
