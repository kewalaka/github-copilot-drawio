# Draw.io canvas extension

Installable Copilot SDK extension folder for the `drawio-architecture` canvas. It includes session-separated drawing bridges, the prebuilt Node runtime, frontend and [drawing guidance](skills/drawio/SKILL.md).

See the [installation steps](https://github.com/kewalaka/github-copilot-drawio#install) and [design and development guide](https://github.com/kewalaka/github-copilot-drawio/blob/main/DESIGN.md) for setup, saving, handoff, privacy and manual upgrades. These repository links also work when this folder is installed without the rest of the checkout.

Open `drawio-architecture` without input for the current session's drawing, or provide an explicit private `runtimeFile` for a shared bridge. Canvas actions are `search_shapes`, `read_document` and `apply_operations`; read the [guidance](skills/drawio/SKILL.md) before editing.

Registration was adapted from the MIT-licensed [official Color Orb extension](https://github.com/github/awesome-copilot/tree/main/extensions/color-orb), using the [Copilot SDK canvas API](https://github.com/github/copilot-sdk/blob/main/nodejs/src/canvas.ts). Retain the supplied [license](LICENSE) and [third-party notices](THIRD_PARTY_NOTICES.txt).
