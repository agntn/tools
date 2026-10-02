import oxfmt from "@agntn/ox/oxfmt";
import oxlint from "@agntn/ox/oxlint";
import { defineConfig } from "vite-plus";

/**
 * Lint, format and test run on Vite+; the build stays on obuild (`build.config.ts`), which
 * bundles TypeBox into `dist/_chunks/libs/typebox.mjs`.
 */
export default defineConfig({
  fmt: { ...oxfmt, ignorePatterns: ["dist", "docs"] },
  lint: {
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
              name: [
                "ToolDefinition",
                "ToolCallContext",
                "ToolResult",
                "OmpToolOptions",
                "CliOptions",
              ],
            },
            {
              from: "package",
              name: ["AgentToolResult", "ExtensionAPI", "Theme", "ToolRenderResultOptions"],
              package: "@oh-my-pi/pi-coding-agent",
            },
            { from: "package", name: "ExtensionAPI", package: "@earendil-works/pi-coding-agent" },
            /* citty's command types are mutable records; the adapter only reads them. */
            {
              from: "package",
              name: ["CommandContext", "CommandDef", "Resolvable", "SubCommandsDef"],
              package: "citty",
            },
          ],
          ignoreInferredTypes: true,
        },
      ],
    },
    ignorePatterns: ["dist", "docs"],
  },
  test: {
    include: ["test/**/*.test.ts"],
  },
});
