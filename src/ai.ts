/**
 * AI SDK adapter: turns {@link ToolDefinition}s into AI SDK tools.
 *
 * The TypeBox schema goes through `jsonSchema()` with the shared validator, so
 * a package needs no second schema in Zod.
 */

import { jsonSchema, tool as aiTool, type Tool } from "ai";

import {
  invokeTool,
  validateInput,
  wireSchema,
  type ToolDefinition,
  type ToolResult,
} from "./index.ts";

/**
 * Builds an AI SDK tool set keyed by tool name.
 *
 * `execute` returns the whole {@link ToolResult}; `toModelOutput` hands the
 * model the same text MCP clients read, and `isError` becomes an error-text
 * output so the model sees the failure as one.
 *
 * @param tools - Tools to convert.
 * @returns {Record<string, Tool>} AI SDK tools.
 */
export function toAiTools(
  tools: readonly ToolDefinition[],
): Record<string, Tool<unknown, ToolResult>> {
  const set: Record<string, Tool<unknown, ToolResult>> = {};
  for (const definition of tools) {
    set[definition.name] = aiTool({
      title: definition.title,
      description: definition.description,
      inputSchema: jsonSchema<unknown>(wireSchema(definition), {
        validate(value) {
          const checked = validateInput(definition, value);
          return checked.ok
            ? { success: true, value: checked.value }
            : { success: false, error: new Error(checked.message) };
        },
      }),
      execute: (input, { abortSignal }) =>
        invokeTool(definition, input, abortSignal ? { signal: abortSignal } : {}),
      toModelOutput({ output }) {
        const text = output.content
          .flatMap((block) => (block.type === "text" ? [block.text] : []))
          .join("\n");
        return output.isError ? { type: "error-text", value: text } : { type: "text", value: text };
      },
    });
  }
  return set;
}
