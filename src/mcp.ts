/**
 * MCP adapter: serves {@link ToolDefinition}s from an unconnected MCP server.
 */

import {
  Server,
  type CallToolResult,
  type InputRequiredResult,
} from "@modelcontextprotocol/server";

import { indexTools, type ToolDefinition } from "./index.ts";
import {
  callAsking,
  canAsk,
  copyIcons,
  errorResult,
  listTools,
  mcpHost,
  progressSteps,
  questionRound,
  type McpServerInfo,
  type ProgressParams,
} from "./mcp-answers.ts";

/** The line under the reason when a dropped answer may hide a write. */
const DROPPED = "The call's answer was dropped, and it may have run. Check before retrying.";

/** Options for {@link createMcpServer}. */
export interface McpServerOptions {
  /** Asked before and after each call: a reason turns it away, `undefined` lets it through. */
  readonly refuse?: () => string | undefined | PromiseLike<string | undefined>;
}

export {
  callTool,
  errorResult,
  listTools,
  toolAnnotations,
  type McpHost,
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
 * A client that declares `elicitation` gets `ask`, through `input_required` on both revisions.
 * A 2026 request carries its capabilities itself, a 2025 one declared them at `initialize`.
 *
 * `host` is an {@link McpHost}: the HTTP request on an HTTP transport, the call's `_meta` on any.
 *
 * `refuse` turns calls away. Past a call that isn't idempotent, it says the call may have run.
 *
 * @param info - Name, version and optional title, description, icons and website, sent as given.
 * @param tools - Tools to serve.
 * @param options - The `refuse` guard.
 * @returns {Server} Unconnected MCP server.
 * @throws {ToolDefinitionError} When two tools share a name.
 */
export function createMcpServer(
  info: McpServerInfo,
  tools: readonly ToolDefinition[],
  options: McpServerOptions = {},
): Server {
  const byName = indexTools(tools);
  const { refuse } = options;
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
  server.setRequestHandler("tools/call", async (request, ctx) =>
    guarded(refuse, byName.get(request.params.name), async () => {
      const meta = ctx.mcpReq._meta;
      const progressToken = meta?.progressToken;
      const notify = (params: ProgressParams): void => {
        ctx.mcpReq
          .notify({ method: "notifications/progress", params: { progressToken, ...params } })
          .catch((error: unknown) => {
            server.onerror?.(error instanceof Error ? error : new Error(String(error)));
          });
      };
      const envelope = ctx.mcpReq.envelope as Readonly<Record<string, unknown>> | undefined;
      const capabilities =
        envelope?.["io.modelcontextprotocol/clientCapabilities"] ?? server.getClientCapabilities();
      const round = canAsk(capabilities)
        ? questionRound(ctx.mcpReq.inputResponses, stateOf(ctx.mcpReq.requestState()))
        : undefined;
      const context = {
        signal: ctx.mcpReq.signal,
        ...mcpHost({ request: ctx.http?.req, meta }),
        ...(progressToken === undefined ? {} : { progress: progressSteps(notify) }),
      };
      const { name, arguments: args } = request.params;
      return await callAsking(info, tools, name, args, context, round);
    }),
  );

  return server;
}

/**
 * Runs the call between the two looks of the guard.
 *
 * @param refuse - The guard, absent when nothing turns calls away.
 * @param tool - The called tool, absent for an unknown name.
 * @param call - The call itself.
 * @returns {Promise<CallToolResult | InputRequiredResult>} The answer, or the guard's reason.
 */
async function guarded(
  refuse: McpServerOptions["refuse"],
  tool: ToolDefinition | undefined,
  call: () => Promise<CallToolResult | InputRequiredResult>,
): Promise<CallToolResult | InputRequiredResult> {
  const before = await refuse?.();
  if (before !== undefined) return errorResult(before);
  const answer = await call();
  const after = await refuse?.();
  if (after === undefined) return answer;
  return mayHaveRun(tool, answer) ? errorResult(after, DROPPED) : errorResult(after);
}

/**
 * Whether a dropped answer may hide a change. A question comes before any effect.
 *
 * @param tool - The called tool, absent for an unknown name.
 * @param answer - What the call answered.
 * @returns {boolean} Whether a retry could repeat something.
 */
function mayHaveRun(tool: ToolDefinition | undefined, answer: object): boolean {
  if (tool === undefined || "resultType" in answer) return false;
  return !(tool.idempotent ?? tool.effect === "read");
}

/**
 * The echoed `requestState` as text. The SDK hands it over raw, and only text is ours.
 *
 * @param state - What `ctx.mcpReq.requestState()` returned.
 * @returns {string | undefined} The state, if it is a string.
 */
function stateOf(state: unknown): string | undefined {
  return typeof state === "string" ? state : undefined;
}
