/**
 * `@nuxtjs/mcp-toolkit` adapter: hands {@link ToolDefinition}s to `defineMcpHandler({ tools })`.
 */

import type { CallToolResult, Tool } from "@modelcontextprotocol/server";
import { z } from "zod";

import { type ToolCallContext, type ToolDefinition } from "./index.ts";
import { callTool, listTools, progressSteps, type ProgressParams } from "./mcp-answers.ts";

/** The part of the SDK v1 request `extra` a handler reads: abort signal and progress. */
export interface ToolkitExtra {
  readonly signal?: AbortSignal;
  readonly _meta?: { readonly progressToken?: string | number };
  readonly sendNotification?: (notification: {
    readonly method: "notifications/progress";
    readonly params: ProgressParams & { readonly progressToken: string | number };
  }) => Promise<void>;
}

/** One toolkit tool. Schemas stay `unknown`, since pnpm gives the toolkit its own `zod` copy. */
export interface ToolkitTool {
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly annotations?: Tool["annotations"];
  readonly inputSchema: unknown;
  readonly outputSchema?: unknown;
  readonly _meta?: Record<string, unknown>;
  readonly handler: (args: unknown, extra?: ToolkitExtra) => Promise<CallToolResult>;
}

/**
 * Turns tools into toolkit entries that list what `listTools` lists and answer via `callTool`.
 *
 * Progress needs the toolkit's sessions: its stateless default answers in plain JSON.
 *
 * @param info - Server info; `name` is the word in the message for an unknown tool.
 * @param tools - Tools to serve.
 * @returns {ToolkitTool[]} Tool definitions in the order given.
 * @throws {ToolDefinitionError} When two tools share a name.
 */
export function toToolkitTools(
  info: { readonly name: string },
  tools: readonly ToolDefinition[],
): ToolkitTool[] {
  return listTools(tools).map((entry) => ({
    name: entry.name,
    title: entry.title,
    description: entry.description,
    annotations: entry.annotations,
    inputSchema: wireObject(entry.inputSchema, true),
    ...(entry.outputSchema === undefined
      ? {}
      : { outputSchema: wireObject(entry.outputSchema, false) }),
    ...(entry._meta === undefined ? {} : { _meta: entry._meta }),
    handler: async (args, extra) => callTool(info, tools, entry.name, args, callContext(extra)),
  }));
}

/**
 * Lists `schema` as written and lets any object through, since SDK v1 takes nothing but Zod.
 *
 * Both hooks sit on private `_zod`. The tests catch a Zod release that moves them.
 *
 * @param schema - The JSON Schema `tools/list` sends.
 * @param input - Whether a call may leave `arguments` out.
 * @returns {z.ZodObject} The stand-in the toolkit hands to the SDK.
 */
function wireObject(schema: Readonly<Record<string, unknown>>, input: boolean): z.ZodObject {
  const object = z.looseObject({});
  object._zod.toJSONSchema = () => ({ ...schema });
  if (!input) return object;
  object._zod.run = missingAsEmpty(object._zod.run.bind(object._zod));
  return object;
}

/**
 * SDK 1.30 hands Zod a missing `arguments` as `undefined`, so read it as the `{}` stdio gets.
 *
 * @param run - The object's own parse step.
 * @returns {typeof run} The same step with `undefined` swapped for `{}`.
 */
function missingAsEmpty(run: z.ZodObject["_zod"]["run"]): z.ZodObject["_zod"]["run"] {
  return (payload, context) =>
    run(payload.value === undefined ? { ...payload, value: {} } : payload, context);
}

/**
 * The abort signal, plus numbered progress for a request with a token. A failed send is dropped.
 *
 * @param extra - The SDK's request extra, absent when a caller skips it.
 * @returns {ToolCallContext} Context for `callTool`.
 */
function callContext(extra: ToolkitExtra | undefined): ToolCallContext {
  const progressToken = extra?._meta?.progressToken;
  const send = extra?.sendNotification;
  return {
    signal: extra?.signal,
    ...(progressToken === undefined || send === undefined
      ? {}
      : {
          progress: progressSteps((params) => {
            send({ method: "notifications/progress", params: { progressToken, ...params } }).catch(
              () => undefined,
            );
          }),
        }),
  };
}
