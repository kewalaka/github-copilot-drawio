import { readFileSync } from "node:fs";

export const drawioGuidance = () => readFileSync(new URL("./skills/drawio/SKILL.md", import.meta.url), "utf8");

export function guidanceOptions() {
  return {
    tools: [{
      name: "drawio_get_guidance",
      description: "Read the reusable draw.io skill before creating or editing diagrams: local shape lookup, XML mechanics and progressive save-confirmed batches.",
      parameters: { type: "object", additionalProperties: false, properties: {} },
      handler: async () => ({ textResultForLlm: drawioGuidance(), resultType: "success" }),
    }],
    hooks: {
      onSessionStart: async () => ({ additionalContext: "For draw.io work, call drawio_get_guidance before editing. The drawio-architecture canvas offers local search_shapes and save-confirmed apply_operations. Build complex drawings in meaningful stages, awaiting each save; preserve manual layout and reassess conflicts." }),
    },
  };
}
