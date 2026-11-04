# Draw.io architecture canvas

A user-installed GitHub Copilot canvas wrapping an existing local draw.io editor bridge. The user and agent edit one `.drawio.svg`, with embedded editable XML. This package contains no diagrams, credentials, local configuration or draw.io assets.

## Use

1. Start the local diagram bridge with Bun. Keep its runtime JSON private.
2. Close any other editor for that diagram and wait 15 seconds for its lease to expire.
3. Ask the agent to open `drawio-architecture` with `runtimeFile` set to the absolute local runtime JSON path.
4. Use `read_document` before `apply_operations`. Pass the revision just read as `expectedRevision`.

New components need stable IDs and geometry. Connectors need endpoints, a label and one of `relationship`, `network` or `data`. Existing component geometry and parent are protected unless the user explicitly permits `relayout: true`. Updates finish only after the editor confirms persistence.

On conflicts, read again and reassess the change. If an update times out, inspect current state before retrying; a timeout does not guarantee rollback. After restarting the bridge, reopen the canvas to load its new loopback URL.

## Boundaries

- Requires the separate local diagram bridge; this wrapper does not install draw.io or start the bridge.
- One active editor per diagram. Closing a canvas does not stop the bridge or delete the SVG.
- After one successful explicit open, omitted input reopens the remembered diagram across panels and provider restarts. Only its runtime path and filename are saved in `$COPILOT_HOME/extensions/drawio-canvas/artifacts/last-bridge.json` (default `~/.copilot`). Delete that file to forget it; supply `runtimeFile` explicitly to change selection or repair configuration. Credentials are reread locally, never saved in preferences.
- Runtime credentials remain inside the local provider. Diagram content returned to the agent is processed by Copilot remotely.
- GitHub gists are unlisted, not confidential storage. Do not add runtime JSON, diagrams or personal configuration here.

Registration was adapted from the MIT-licensed [official Color Orb extension](https://github.com/github/awesome-copilot/tree/main/extensions/color-orb), using the [Copilot SDK canvas API](https://github.com/github/copilot-sdk/blob/main/nodejs/src/canvas.ts). The example renderer was replaced with the local bridge. Keep the supplied license.
