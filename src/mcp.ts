/**
 * MCP adapter: serves {@link ToolDefinition}s from an unconnected MCP server.
 */

import {
  Server,
  type CallToolResult,
  type Tool,
  type ToolAnnotations,
} from "@modelcontextprotocol/server";

import {
  indexTools,
  invokeTool,
  sanitizeLine,
  ToolInputError,
  wireSchema,
  type ToolCallContext,
  type ToolDefinition,
} from "./index.ts";

export interface McpServerInfo {
  /** Server name, also used in the unknown-tool message. */
  readonly name: string;
  readonly version: string;
  /** Display name for clients that show one, such as `Forges`. */
  readonly title?: string;
  /** Project home a client can link to. */
  readonly websiteUrl?: string;
}

/**
 * Maps a tool's title and declared effect to MCP annotations. Claude Code reads its label here.
 *
 * @param tool - Tool to describe.
 * @returns {ToolAnnotations} Title and hints for the MCP client.
 */
export function toolAnnotations(tool: ToolDefinition): ToolAnnotations {
  return {
    title: tool.title,
    readOnlyHint: tool.effect === "read",
    destructiveHint: tool.effect === "destructive",
    idempotentHint: tool.idempotent ?? tool.effect === "read",
    openWorldHint: tool.openWorld ?? false,
  };
}

/**
 * Error result with every line-forging character replaced.
 *
 * The messages echo client-controlled values (a tool name, an argument) and
 * downstream error text, so they pass through here on every branch. Each line
 * is cleaned on its own, so only the breaks between the lines passed in
 * survive; a newline inside one line becomes a space.
 *
 * @param lines - Error lines.
 * @returns {CallToolResult} MCP error result.
 */
export function errorResult(...lines: readonly string[]): CallToolResult {
  return { content: [{ type: "text", text: lines.map(sanitizeLine).join("\n") }], isError: true };
}

/**
 * The entries `tools/list` answers with, in the order given.
 *
 * @param tools - Tools to list.
 * @returns {Tool[]} Name, title, description, schema and annotations of each tool.
 */
export function listTools(tools: readonly ToolDefinition[]): Tool[] {
  return tools.map((tool) => ({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: wireSchema(tool) as Tool["inputSchema"],
    annotations: toolAnnotations(tool),
  }));
}

/**
 * Answers one call as `tools/call` does and never throws, so every transport gives the same text.
 *
 * @param info - Server info; `name` is the word in the message for an unknown tool.
 * @param tools - Tools to look the name up in.
 * @param name - Tool name as the client sent it.
 * @param args - Arguments as the client sent them; missing ones count as `{}`.
 * @param context - Context for this call, such as the request's abort signal.
 * @returns {Promise<CallToolResult>} The tool's text, or the sanitized error.
 */
export async function callTool(
  info: Pick<McpServerInfo, "name">,
  tools: readonly ToolDefinition[],
  name: string,
  args: unknown = {},
  context: ToolCallContext = {},
): Promise<CallToolResult> {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) return errorResult(`Unknown ${info.name} tool: ${JSON.stringify(name)}`);

  try {
    const result = await invokeTool(tool, args, context);
    return {
      content: result.content,
      ...(result.isError === undefined ? {} : { isError: result.isError }),
    };
  } catch (error) {
    if (error instanceof ToolInputError) return errorResult(...error.lines);
    return errorResult(
      `${tool.name} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

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
 * `details` never reaches the client and `structuredContent` is never set:
 * clients that see structured output prefer it over `content` and would hide
 * the readable answer. Every fact a follow-up call needs belongs in the text.
 *
 * @param info - Server name, version and optional title and website, sent to the client as given.
 * @param tools - Tools to serve.
 * @returns {Server} Unconnected MCP server.
 * @throws {ToolDefinitionError} When two tools share a name.
 */
export function createMcpServer(info: McpServerInfo, tools: readonly ToolDefinition[]): Server {
  indexTools(tools);
  const { name, version, title, websiteUrl } = info;
  const server = new Server({ name, version, title, websiteUrl }, { capabilities: { tools: {} } });

  server.setRequestHandler("tools/list", () => ({ tools: listTools(tools) }));
  server.setRequestHandler("tools/call", (request, ctx) =>
    callTool(info, tools, request.params.name, request.params.arguments, {
      signal: ctx.mcpReq.signal,
    }),
  );

  return server;
}
