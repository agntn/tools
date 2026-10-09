/**
 * h3-mcp adapter: hands {@link ToolDefinition}s to `defineMcpHandler` from h3-mcp.
 */

import type { JsonSchema, ToolDefinition as H3ToolDefinition } from "h3-mcp";

import { type ToolCallContext, type ToolDefinition } from "./index.ts";
import {
  callAsking,
  canAsk,
  listTools,
  progressSteps,
  questionRound,
  type QuestionRound,
} from "./mcp-answers.ts";

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
 * `ask` reaches a client with `elicitation` on the 2026 revision only: h3-mcp has no 2025 shim.
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
    ...(entry.outputSchema === undefined ? {} : { outputSchema: entry.outputSchema as JsonSchema }),
    annotations: entry.annotations,
    ...(entry._meta === undefined ? {} : { _meta: entry._meta }),
    handler: async (args, event) => {
      // Read now: a legacy batch shares one context between its calls.
      const mcp = event.context.mcp;
      const round = roundOf(mcp);
      const progress = mcp?.progressToken === undefined ? undefined : mcp.progress;
      const context: ToolCallContext = {
        signal: mcp?.signal,
        ...(progress === undefined ? {} : { progress: numbered(progress) }),
      };
      return await callAsking(info, tools, entry.name, args, context, round);
    },
  }));
}

/** The fields of `event.context.mcp` a question reads. */
interface AskingRequest {
  readonly era?: "modern" | "legacy";
  readonly clientCapabilities?: unknown;
  readonly inputResponses?: Readonly<Record<string, unknown>>;
  readonly requestState?: string;
}

/**
 * A round of questions for a client that can answer. h3-mcp has no shim for 2025 requests.
 *
 * @param mcp - The request's MCP context.
 * @returns {QuestionRound | undefined} The round on a 2026 request from a client with elicitation.
 */
function roundOf(mcp: AskingRequest | undefined): QuestionRound | undefined {
  if (mcp?.era !== "modern" || !canAsk(mcp.clientCapabilities)) return undefined;
  return questionRound(mcp.inputResponses, mcp.requestState);
}

/**
 * The executor's progress over h3-mcp's own sender, numbered as the `Server` numbers it.
 *
 * @param send - `event.context.mcp.progress`, for a request with a token.
 * @returns {NonNullable<ToolCallContext["progress"]>} The callback for `execute`.
 */
function numbered(
  send: (progress: number, total?: number, message?: string) => void,
): NonNullable<ToolCallContext["progress"]> {
  return progressSteps(({ progress, total, message }) => send(progress, total, message));
}
