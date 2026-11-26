/** What a tool's `effect` promises, in MCP's words. MCP and Pi both read them. */

import type { ToolDefinition } from "./index.ts";

/** The four hints MCP annotations and Pi's `annotations` share. */
export interface ToolHints {
  readonly readOnlyHint: boolean;
  readonly destructiveHint: boolean;
  readonly idempotentHint: boolean;
  readonly openWorldHint: boolean;
}

/**
 * Hints from the declared effect. A process the tool starts can delete anything, so `exec` counts.
 *
 * @param tool - Tool to describe.
 * @returns {ToolHints} All four, so no host assumes the worst.
 */
export function toolHints(tool: ToolDefinition): ToolHints {
  return {
    readOnlyHint: tool.effect === "read",
    destructiveHint: tool.effect === "destructive" || tool.effect === "exec",
    idempotentHint: tool.idempotent ?? tool.effect === "read",
    openWorldHint: tool.openWorld ?? false,
  };
}
