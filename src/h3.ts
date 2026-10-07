/**
 * h3-mcp adapter: hands {@link ToolDefinition}s to `defineMcpHandler` from h3-mcp.
 */

import type { JsonSchema, ToolDefinition as H3ToolDefinition } from "h3-mcp";

import { type ToolCallContext, type ToolDefinition } from "./index.ts";
import { callTool, listTools, progressSteps } from "./mcp-answers.ts";

/** An h3-mcp tool whose `inputSchema` is the plain JSON Schema `tools/list` sends. */
export type H3Tool = H3ToolDefinition<JsonSchema>;

/**
 * Turns tools into h3-mcp tool definitions for `defineMcpHandler({ tools })`.
 *
 * Each entry carries what `listTools` lists, and its handler answers through
 * `callTool`, so the text, the validation lines and the sanitized errors are the
 * ones every other MCP transport gives. The schema goes out as plain JSON
 * Schema, which h3-mcp passes through without validating; the core validates
 * instead. An unknown name never reaches a handler: h3-mcp answers it itself
 * with a JSON-RPC error.
 *
 * Imports only types from h3-mcp, so the adapter loads neither h3-mcp nor the MCP SDK.
 *
 * @param info - Server info; `name` is the word in the message for an unknown tool.
 * @param tools - Tools to serve.
 * @returns {H3Tool[]} Tool definitions in the order given.
 * @throws {ToolDefinitionError} When two tools share a name.
 */
export function toH3Tools(
  info: { readonly name: string },
  tools: readonly ToolDefinition[],
): H3Tool[] {
  return listTools(tools).map((entry) => ({
    name: entry.name,
    title: entry.title,
    description: entry.description,
    ...(entry.icons === undefined ? {} : { icons: entry.icons }),
    inputSchema: entry.inputSchema as JsonSchema,
    annotations: entry.annotations,
    handler: (args, event) => {
      // Read now: a legacy batch shares one context between its calls.
      const mcp = event.context.mcp;
      const context: ToolCallContext = {
        signal: mcp?.signal,
        ...(mcp?.progressToken === undefined || mcp.progress === undefined
          ? {}
          : {
              progress: progressSteps(({ progress, total, message }) =>
                mcp.progress?.(progress, total, message),
              ),
            }),
      };
      return callTool(info, tools, entry.name, args, context);
    },
  }));
}
