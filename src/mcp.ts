/**
 * MCP adapter: serves {@link ToolDefinition}s from an unconnected MCP server.
 */

import { Server } from "@modelcontextprotocol/server";

import { indexTools, type ToolDefinition } from "./index.ts";
import {
  callTool,
  copyIcons,
  listTools,
  progressSteps,
  type McpServerInfo,
  type ProgressParams,
} from "./mcp-answers.ts";

export {
  callTool,
  errorResult,
  listTools,
  toolAnnotations,
  type McpServerInfo,
} from "./mcp-answers.ts";

/**
 * Creates an unconnected MCP server exposing the tools.
 *
 * Built on the low-level `Server` of MCP SDK v2, which the SDK marks
 * `@deprecated`, not on `McpServer`. `McpServer.registerTool` in 2.2.0 would
 * take the schema, but it answers `toString`, `constructor` and `__proto__` as
 * "Tool toString disabled" (a lookup that reaches `Object.prototype`), echoes a
 * raw tool name with newlines and escapes into its error, joins validation
 * failures into one line and passes a thrown message through unsanitized.
 *
 * `details` reach the client only from a tool with `output`, as `structuredContent`:
 * clients that see structured output prefer it over `content` and would hide
 * the readable answer. Every fact a follow-up call needs belongs in the text.
 *
 * A progress notification that fails to send goes to `onerror`, never to the tool.
 *
 * @param info - Name, version and optional title, description, icons and website, sent as given.
 * @param tools - Tools to serve.
 * @returns {Server} Unconnected MCP server.
 * @throws {ToolDefinitionError} When two tools share a name.
 */
export function createMcpServer(info: McpServerInfo, tools: readonly ToolDefinition[]): Server {
  indexTools(tools);
  const { name, version, title, description, icons, websiteUrl } = info;
  const server = new Server(
    {
      name,
      version,
      title,
      description,
      ...(icons === undefined ? {} : { icons: copyIcons(icons) }),
      websiteUrl,
    },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler("tools/list", () => ({ tools: listTools(tools) }));
  server.setRequestHandler("tools/call", (request, ctx) => {
    const progressToken = ctx.mcpReq._meta?.progressToken;
    const notify = (params: ProgressParams): void => {
      ctx.mcpReq
        .notify({ method: "notifications/progress", params: { progressToken, ...params } })
        .catch((error: unknown) => {
          server.onerror?.(error instanceof Error ? error : new Error(String(error)));
        });
    };
    return callTool(info, tools, request.params.name, request.params.arguments, {
      signal: ctx.mcpReq.signal,
      ...(progressToken === undefined ? {} : { progress: progressSteps(notify) }),
    });
  });

  return server;
}
