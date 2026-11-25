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
            /* These carry TypeBox schemas, a signal or a request; no adapter writes to them. */
            {
              from: "file",
              name: [
                "ToolDefinition",
                "ToolQuestion",
                "HostQuestion",
                "ToolCallContext",
                "ToolResult",
                "OmpToolOptions",
                "CliOptions",
                "Command",
                "PartialResult",
              ],
            },
            /* The discovery hook hands over a card to fill in, so this one is written to. */
            { from: "file", name: ["ToolkitServerCard"] },
            {
              from: "package",
              name: ["AgentToolResult", "ExtensionAPI", "ToolRenderResultOptions"],
              package: "@oh-my-pi/pi-coding-agent",
            },
            /* OMP 19 declares the theme in its TUI package. */
            { from: "package", name: ["Theme"], package: "@oh-my-pi/pi-tui" },
            {
              from: "package",
              name: ["ExtensionAPI", "ExtensionContext"],
              package: "@earendil-works/pi-coding-agent",
            },
            { from: "package", name: ["Context", "ToolContext"], package: "@opencode/plugin" },
            /* `serveStdio` takes the transport over and sets its handlers. */
            {
              from: "package",
              name: ["Transport", "ServeStdioOptions"],
              package: "@modelcontextprotocol/server",
            },
            { from: "lib", name: ["AbortSignal", "Request"] },
          ],
          ignoreInferredTypes: true,
        },
      ],
    },
    /** `test/copies` reads `dist/` declarations: `typecheck:dist` checks it after the build. */
    ignorePatterns: ["dist", "docs", "test/copies"],
  },
  test: {
    include: ["test/**/*.test.ts"],
  },
});
