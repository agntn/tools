/**
 * `@nuxtjs/mcp-toolkit` adapter: hands {@link ToolDefinition}s to `defineMcpHandler({ tools })`.
 */

import { z } from "zod";

import { type Icon, type ToolCallContext, type ToolDefinition } from "./index.ts";
import { callTool, copyIcons, listTools, mcpHost, progressSteps } from "./mcp-answers.ts";
import { hostAsk } from "./questions.ts";

/** What SDK v1 keeps of the HTTP request. */
export interface ToolkitRequestInfo {
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  readonly url?: { readonly href: string };
}

/** The part of the SDK v1 request `extra` a handler reads: abort signal, progress and questions. */
export interface ToolkitExtra {
  readonly signal?: AbortSignal;
  /** Present on an HTTP transport. */
  readonly requestInfo?: ToolkitRequestInfo;
  readonly _meta?: { readonly [key: string]: unknown; readonly progressToken?: string | number };
  readonly sendNotification?: (notification: {
    readonly method: "notifications/progress";
    readonly params: {
      readonly progressToken: string | number;
      readonly progress: number;
      readonly total?: number;
      readonly message: string;
    };
  }) => Promise<void>;
  /** Both schemas are `never`, so SDK v1's method fits whatever Zod and schema types it carries. */
  readonly sendRequest?: (
    request: {
      readonly method: "elicitation/create";
      readonly params: {
        readonly mode: "form";
        readonly message: string;
        readonly requestedSchema: never;
      };
    },
    resultSchema: never,
    options?: { readonly signal?: AbortSignal },
  ) => Promise<unknown>;
}

/** The toolkit's `useMcpElicitation`, or anything that knows if the client fills forms. */
export type ToolkitElicitation = () => { readonly supports: (mode?: "form") => boolean };

/** How `toToolkitTools` reaches the person behind the client. */
export interface ToolkitOptions {
  /** Pass `useMcpElicitation` to give `execute` an `ask`. It runs in every handler. */
  readonly elicitation?: ToolkitElicitation;
}

export type { McpHost } from "./mcp-answers.ts";

/** What a handler answers. The toolkit runs SDK v1, so these types never name the v2 package. */
export interface ToolkitResult {
  [key: string]: unknown;
  content: Array<{ [key: string]: unknown; type: string }>;
  isError?: boolean;
}

/** One toolkit tool. Schemas stay `unknown`, since pnpm gives the toolkit its own `zod` copy. */
export interface ToolkitTool {
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly annotations?: {
    readonly title?: string;
    readonly readOnlyHint?: boolean;
    readonly destructiveHint?: boolean;
    readonly idempotentHint?: boolean;
    readonly openWorldHint?: boolean;
  };
  readonly inputSchema: unknown;
  readonly outputSchema?: unknown;
  readonly _meta?: Record<string, unknown>;
  readonly handler: (args: unknown, extra?: ToolkitExtra) => Promise<ToolkitResult>;
}

/**
 * Turns tools into toolkit entries that list what `listTools` lists and answer via `callTool`.
 *
 * `host` is an {@link McpHost} with the call's `_meta` and a `Request` rebuilt from SDK v1's
 * `requestInfo`: the caller's URL and headers, but no body and always `GET`.
 *
 * Progress and questions need the toolkit's sessions: its stateless default answers in plain JSON.
 * `useMcpElicitation` also needs Nitro's `asyncContext`, since it finds the server in the request.
 *
 * @param info - Server info; `name` is the word in the message for an unknown tool.
 * @param tools - Tools to serve.
 * @param options - Where `ask` comes from; without it there is none.
 * @returns {ToolkitTool[]} Tool definitions in the order given.
 * @throws {ToolDefinitionError} When two tools share a name.
 */
export function toToolkitTools(
  info: { readonly name: string },
  tools: readonly ToolDefinition[],
  options: ToolkitOptions = {},
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
    handler: async (args, extra) =>
      callTool(info, tools, entry.name, args, {
        ...callContext(extra),
        ...formAsk(extra, options.elicitation),
      }),
  }));
}

/** The server as the card shows it. An `McpServerInfo` fits, and so does a bare `{ name }`. */
export interface ToolkitServerInfo {
  readonly name: string;
  readonly version?: string;
  readonly title?: string;
  readonly description?: string;
  readonly icons?: readonly Icon[];
  readonly websiteUrl?: string;
}

/** The card nuxt-agent-discovery serves at `/.well-known/mcp/server-card.json`, filled in place. */
export interface ToolkitServerCard {
  [key: string]: unknown;
}

/** What the card lists per tool. */
interface CardTool {
  readonly name: string;
  readonly description: string;
}

/**
 * Hook for `agent-discovery:mcp-server-card`: our `serverInfo`, then our tools after the rest.
 *
 * @param info - Server info, given as to `defineMcpHandler`.
 * @param tools - Tools the `/mcp` route serves.
 * @returns {(event: unknown, card: ToolkitServerCard) => void} The hook, which ignores the event.
 * @throws {ToolDefinitionError} When two tools share a name.
 */
export function serverCardHook(
  info: ToolkitServerInfo,
  tools: readonly ToolDefinition[],
): (event: unknown, card: ToolkitServerCard) => void {
  const listed: readonly CardTool[] = listTools(tools).map(({ name, description = "" }) => ({
    name,
    description,
  }));
  const ours = new Set(listed.map(({ name }) => name));
  const serverInfo = {
    ...info,
    ...(info.icons === undefined ? {} : { icons: copyIcons(info.icons) }),
  };
  const theirs = (entry: unknown): boolean => {
    const { name } = plainObject(entry);
    return typeof name !== "string" || !ours.has(name);
  };
  return (_event, card) => {
    card.serverInfo = { ...plainObject(card.serverInfo), ...serverInfo };
    card.tools = [
      ...(Array.isArray(card.tools as unknown) ? (card.tools as readonly unknown[]) : []).filter(
        theirs,
      ),
      ...listed.map((tool) => ({ ...tool })),
    ];
  };
}

/**
 * The value itself when it is a plain object, else an empty one.
 *
 * @param value - Whatever the card holds there.
 * @returns {Readonly<Record<string, unknown>>} Something safe to spread.
 */
function plainObject(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};
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
 * The abort signal, request and `_meta` as `host`, plus numbered progress for a request with a
 * token. A failed send is dropped.
 *
 * @param extra - The SDK's request extra, absent when a caller skips it.
 * @returns {ToolCallContext} Context for `callTool`.
 */
function callContext(extra: ToolkitExtra | undefined): ToolCallContext {
  const progressToken = extra?._meta?.progressToken;
  const send = extra?.sendNotification;
  return {
    signal: extra?.signal,
    ...mcpHost({ request: rebuiltRequest(extra?.requestInfo), meta: extra?._meta }),
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

/**
 * A bodiless `Request` from the URL and headers SDK v1 kept.
 *
 * @param info - The SDK's `requestInfo`.
 * @returns {Request | undefined} Nothing without a usable URL.
 */
function rebuiltRequest(info: ToolkitRequestInfo | undefined): Request | undefined {
  if (info?.url === undefined) return undefined;
  const headers = new Headers();
  for (const [name, value] of Object.entries(info.headers)) {
    for (const item of [value ?? []].flat()) {
      if (isHeader(name, item)) headers.append(name, item);
    }
  }
  try {
    return new Request(info.url.href, { headers });
  } catch {
    return undefined;
  }
}

/**
 * Whether `Headers` takes the pair. It refuses HTTP/2's `:path`.
 *
 * @param name - Header name.
 * @param value - Header value.
 * @returns {boolean} False when `append` would throw.
 */
function isHeader(name: string, value: string): boolean {
  try {
    return new Headers([[name, value]]).has(name);
  } catch {
    return false;
  }
}

/**
 * An `ask` on this call's own stream. The toolkit's `form()` wants a Zod shape, so only `supports`.
 *
 * @param extra - The SDK's request extra, absent when a caller skips it.
 * @param elicitation - The toolkit's `useMcpElicitation`, when the server passed it.
 * @returns {Pick<ToolCallContext, "ask">} The `ask`, or nothing for a client that fills no forms.
 */
function formAsk(
  extra: ToolkitExtra | undefined,
  elicitation: ToolkitElicitation | undefined,
): Pick<ToolCallContext, "ask"> {
  const send = extra?.sendRequest;
  if (send === undefined || elicitation?.().supports("form") !== true) return {};
  const reply = z.looseObject({}) as never;
  return {
    ask: hostAsk(
      async ({ message, requested }) =>
        await send(
          {
            method: "elicitation/create",
            params: { mode: "form", message, requestedSchema: requested as never },
          },
          reply,
          { signal: extra?.signal },
        ),
    ),
  };
}
