/**
 * What `tools/list` and `tools/call` answer, without the MCP SDK at runtime.
 *
 * Shared by the `Server` in `mcp.ts` and the h3-mcp adapter in `h3.ts`, so a
 * transport that brings its own JSON-RPC layer never loads the SDK.
 */

import type { CallToolResult, Tool, ToolAnnotations } from "@modelcontextprotocol/server";

import {
  indexTools,
  invokeTool,
  sanitizeLine,
  ToolInputError,
  wireSchema,
  type Icon,
  type ToolCallContext,
  type ToolDefinition,
} from "./index.ts";

export interface McpServerInfo {
  /** Server name, also used in the unknown-tool message. */
  readonly name: string;
  readonly version: string;
  /** Display name for clients that show one, such as `Forges`. */
  readonly title?: string;
  /** One line under the name on a connector card or in a registry. */
  readonly description?: string;
  readonly icons?: readonly Icon[];
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
 * @returns {Tool[]} Name, title, description, icons, schema and annotations of each tool.
 * @throws {ToolDefinitionError} When two tools share a name.
 */
export function listTools(tools: readonly ToolDefinition[]): Tool[] {
  indexTools(tools);
  return tools.map((tool) => ({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    ...(tool.icons === undefined ? {} : { icons: copyIcons(tool.icons) }),
    inputSchema: wireSchema(tool) as Tool["inputSchema"],
    annotations: toolAnnotations(tool),
  }));
}

/**
 * Icons as the SDK types them, mutable arrays included.
 *
 * @param icons - Icons from a definition or the server info.
 * @returns {NonNullable<Tool["icons"]>} The same icons, copied.
 */
export function copyIcons(icons: readonly Icon[]): NonNullable<Tool["icons"]> {
  return icons.map(({ sizes, ...rest }) =>
    sizes === undefined ? rest : { ...rest, sizes: [...sizes] },
  );
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

/** One `notifications/progress` without its token. */
export interface ProgressParams {
  readonly progress: number;
  readonly total?: number;
  readonly message: string;
}

/**
 * Numbers progress lines for MCP: a bare line counts one up, an amount that doesn't grow drops.
 *
 * @param notify - Sends one notification for the request.
 * @returns {NonNullable<ToolCallContext["progress"]>} The callback for `execute`.
 */
export function progressSteps(
  notify: (params: ProgressParams) => void,
): NonNullable<ToolCallContext["progress"]> {
  let last: number | undefined;
  return (message, amount) => {
    const progress = amount?.progress ?? (last ?? 0) + 1;
    if (!Number.isFinite(progress) || (last !== undefined && progress <= last)) return;
    last = progress;
    const total = amount?.total;
    notify({ progress, ...(Number.isFinite(total) ? { total } : {}), message });
  };
}
