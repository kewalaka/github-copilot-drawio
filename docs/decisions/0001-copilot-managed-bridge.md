# Run the bridge inside the Copilot extension

Status: Accepted · 2026-11-07

## Decision

Use Node's HTTP server inside Copilot's documented extension process. Keep Bun for development and building the production JavaScript bundle, not as an installation requirement.

The packaged Copilot executable is not a documented standalone Node launcher. Spawning it as `node server.js` would depend on unsupported behavior. Starting the service in the extension avoids that dependency.

## Consequences

- Each session keeps its drawing on disk. Extension restart restores it; panel identity is not document identity.
- Services started by the extension close with that provider. A runtime file's PID may identify the provider, so it must not be used to kill one drawing's service.
- Ship a generated bundle with the existing XML library, frontend and licence notices. Source changes require rebuilding it before publication.
- Download and validate the pinned browser editor locally when needed. Desktop draw.io is optional.
- Installing new files does not reload a running provider. Installation and provider reload remain distinct steps.
