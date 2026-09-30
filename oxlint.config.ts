import oxlint from "@agntn/ox/oxlint";
import { defineConfig } from "oxlint";

export default defineConfig({
  ...oxlint,
  rules: {
    ...oxlint.rules,
    "typescript/prefer-readonly-parameter-types": [
      "error",
      {
        allow: [
          /* A definition carries TypeBox schemas and an abort signal; no adapter writes to them. */
          {
            from: "file",
            name: ["ToolDefinition", "ToolCallContext", "ToolResult", "OmpToolOptions"],
          },
          {
            from: "package",
            name: ["AgentToolResult", "ExtensionAPI", "Theme", "ToolRenderResultOptions"],
            package: "@oh-my-pi/pi-coding-agent",
          },
          { from: "package", name: "ExtensionAPI", package: "@earendil-works/pi-coding-agent" },
        ],
        ignoreInferredTypes: true,
      },
    ],
  },
  ignorePatterns: [],
});
