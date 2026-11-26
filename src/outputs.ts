/** What a declared `output` lets out, shared by MCP's `structuredContent` and Pi's. */

import { Value } from "typebox/value";

import type { ToolDefinition } from "./index.ts";

/** The details as data, or the lines that say why they can't go out as data. */
export type DetailsCheck =
  | { readonly ok: true; readonly value: Record<string, unknown> }
  | { readonly ok: false; readonly lines: readonly string[] };

/**
 * Details checked against `output`, so no host gets data lying about its shape.
 *
 * @param tool - Tool that answered.
 * @param details - The details of a successful result.
 * @returns {DetailsCheck | undefined} The details or the failure lines; nothing without `output`.
 */
export function checkDetails(tool: ToolDefinition, details: unknown): DetailsCheck | undefined {
  const { output } = tool;
  if (output === undefined) return undefined;
  if (Value.Check(output, details)) {
    return { ok: true, value: details as Record<string, unknown> };
  }
  return {
    ok: false,
    lines: [
      `${tool.name} returned details that don't match its output schema`,
      ...[...Value.Errors(output, details)].map(
        (failure) => `at ${failure.instancePath || "/"}: ${failure.message}`,
      ),
    ],
  };
}
