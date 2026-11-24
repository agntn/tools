/**
 * Plain HTTP adapter: serves {@link ToolDefinition}s as JSON over Fetch.
 */

import { causeLines } from "./causes.ts";
import {
  indexTools,
  invokeTool,
  resultText,
  sanitizeLine,
  ToolInputError,
  wireSchema,
  type ToolCallContext,
  type ToolDefinition,
  type ToolEffect,
  type ToolProgress,
  type ToolResult,
} from "./index.ts";

/** The body cap `createMcpHandler` from the MCP SDK uses, 4 MiB. */
const MAX_BODY = 4 * 1024 * 1024;

/** Every effect a tool can declare. */
const EFFECTS: readonly ToolEffect[] = ["read", "write", "destructive", "exec"];

/** What `GET /` names the server by. */
export interface HttpServerInfo {
  /** Server name, also the word in the message for an unknown tool. */
  readonly name: string;
  readonly version: string;
}

/** Options for {@link createHttpHandler}. */
export interface HttpHandlerOptions {
  /** Effects served, `["read"]` by default. */
  readonly effects?: readonly ToolEffect[];
  /** Mount path, such as `/http/memory`. The root by default. */
  readonly base?: string;
  /** Largest body in bytes, 4 MiB by default. A bigger one gets 413. */
  readonly maxRequestBodySize?: number;
}

/** What a tool finds in `host` over HTTP. The client wrote it, so it proves nothing. */
export interface HttpHost {
  readonly http: true;
  /** The request behind the call, headers included. */
  readonly request: Request;
}

/** One tool as `GET /` lists it. */
export interface HttpToolEntry {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly effect: ToolEffect;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

/** What `GET /` answers. */
export interface HttpListing {
  readonly name: string;
  readonly version: string;
  readonly tools: readonly HttpToolEntry[];
}

/** What a tool answered: status 200, or 422 when it set `isError`. */
export interface HttpAnswer {
  /** The text blocks joined by newlines. */
  readonly text: string;
  readonly details: unknown;
  /** The result's image blocks, present only when it has some. */
  readonly images?: readonly { readonly data: string; readonly mimeType: string }[];
}

/** Why the call never got an answer: bad input, an unknown tool, a throw. */
export interface HttpRefusal {
  /** One line each, cleaned of anything that forges a line. */
  readonly lines: readonly string[];
}

/** One `progress` event of a streamed call. Numbers only when the tool gave them. */
export interface HttpProgress {
  readonly message: string;
  readonly progress?: number;
  readonly total?: number;
}

/** The `result` event ending a stream: the plain body plus its status. */
export type HttpResult = (HttpAnswer | HttpRefusal) & { readonly status: number };

/** A Fetch handler: `Request` in, `Response` out. */
export interface HttpHandler {
  readonly fetch: (request: Request) => Promise<Response>;
}

/** The fixed parts of one handler. */
interface Served {
  readonly info: HttpServerInfo;
  readonly base: string;
  readonly maxBody: number;
  readonly effects: readonly ToolEffect[];
  readonly tools: readonly ToolDefinition[];
  readonly listing: HttpListing;
}

/**
 * Serves tools as JSON: `GET /` lists them, `POST /<tool name>` calls one.
 * A call with `Accept: text/event-stream` streams its progress before the answer.
 *
 * @param info - Name and version for the listing.
 * @param tools - Tools to serve.
 * @param options - The served effects and the mount path.
 * @returns {HttpHandler} The handler, with `fetch` bound to it.
 * @throws {ToolDefinitionError} When two tools share a name.
 * @throws {TypeError} When `base` or `effects` is malformed.
 * @throws {RangeError} When `maxRequestBodySize` isn't a positive number.
 */
export function createHttpHandler(
  info: HttpServerInfo,
  tools: readonly ToolDefinition[],
  options: HttpHandlerOptions = {},
): HttpHandler {
  indexTools(tools);
  const effects = servedEffects(options.effects);
  const listed = tools.filter((tool) => effects.includes(tool.effect)).map(entryOf);
  const served: Served = {
    info,
    base: basePath(options.base),
    maxBody: bodyLimit(options.maxRequestBodySize),
    effects,
    tools: [...tools],
    listing: { name: info.name, version: info.version, tools: listed },
  };
  return { fetch: async (request) => await route(served, request) };
}

/**
 * The effects to serve, checked, since a typo would quietly serve nothing.
 *
 * @param effects - The option as given.
 * @returns {ToolEffect[]} A copy, `["read"]` when absent.
 * @throws {TypeError} When it isn't a list of known effects.
 */
function servedEffects(effects: readonly ToolEffect[] | undefined): ToolEffect[] {
  if (effects === undefined) return ["read"];
  if (!Array.isArray(effects as unknown)) {
    throw new TypeError(`effects must be a list, got ${JSON.stringify(effects)}`);
  }
  const stray = effects.find((effect) => !EFFECTS.includes(effect));
  if (stray !== undefined) {
    throw new TypeError(`effects takes ${EFFECTS.join(", ")}, got ${JSON.stringify(stray)}`);
  }
  return [...effects];
}

/**
 * The mount path as `URL` encodes it, without its trailing slash, the root as `""`.
 *
 * @param base - The path as given.
 * @returns {string} A path to compare the request path with.
 * @throws {TypeError} When it doesn't start with a slash.
 */
function basePath(base: string | undefined): string {
  if (base === undefined) return "";
  if (!base.startsWith("/"))
    throw new TypeError(`base must start with "/", got ${JSON.stringify(base)}`);
  return new URL(base, "http://localhost").pathname.replace(/\/+$/, "");
}

/**
 * The body cap, checked like the MCP SDK checks its own.
 *
 * @param size - The option as given.
 * @returns {number} The cap in bytes.
 * @throws {RangeError} When it isn't a positive number.
 */
function bodyLimit(size: number | undefined): number {
  if (size === undefined) return MAX_BODY;
  if (typeof size !== "number" || !Number.isFinite(size) || size <= 0) {
    throw new RangeError(
      `maxRequestBodySize must be a positive number of bytes, got ${String(size)}`,
    );
  }
  return size;
}

/**
 * One tool as the listing shows it.
 *
 * @param tool - Tool to list.
 * @returns {HttpToolEntry} Its name, title, description, effect and wire schema.
 */
function entryOf(tool: ToolDefinition): HttpToolEntry {
  const { name, title, description, effect } = tool;
  return { name, title, description, effect, inputSchema: wireSchema(tool) };
}

/**
 * Sends the request to the listing or to one tool.
 *
 * @param served - The handler's fixed parts.
 * @param request - The incoming request.
 * @returns {Promise<Response>} The JSON answer.
 */
async function route(served: Served, request: Request): Promise<Response> {
  const { pathname } = new URL(request.url);
  const name = toolPath(served.base, pathname);
  if (name === "") {
    return request.method === "GET" ? Response.json(served.listing) : wrongMethod("GET");
  }
  if (name === undefined) return refusal(404, `Nothing at ${pathname}`);
  if (request.method !== "POST") return wrongMethod("POST");
  return await call(served, name, request);
}

/**
 * The tool name a path asks for, past the mount path.
 *
 * @param base - The mount path, the root as the empty string.
 * @param pathname - The request path.
 * @returns {string | undefined} The name, `""` for the listing, `undefined` for no route.
 */
function toolPath(base: string, pathname: string): string | undefined {
  if (!pathname.startsWith(base)) return undefined;
  const rest = pathname.slice(base.length);
  if (rest === "" || rest === "/") return "";
  const name = rest.slice(1);
  return rest.startsWith("/") && name !== "" && !name.includes("/") ? name : undefined;
}

/**
 * Finds the tool, reads the body and runs the call.
 *
 * @param served - The handler's fixed parts.
 * @param name - Tool name from the path.
 * @param request - The incoming request.
 * @returns {Promise<Response>} The tool's answer, or why there is none.
 */
async function call(served: Served, name: string, request: Request): Promise<Response> {
  const tool = served.tools.find((candidate) => candidate.name === name);
  if (tool === undefined) {
    return refusal(404, `Unknown ${served.info.name} tool: ${JSON.stringify(name)}`);
  }
  if (!served.effects.includes(tool.effect)) {
    const allowed = served.effects.join(", ") || "nothing";
    return refusal(
      403,
      `${tool.name} is a ${tool.effect} tool, and this handler serves ${allowed}`,
    );
  }
  if (!isJson(request.headers.get("content-type"))) {
    return refusal(415, "Send the input as Content-Type: application/json");
  }
  const input = await readInput(request, served.maxBody);
  if (!input.ok) return refusal(input.status, input.line);
  if (wantsStream(request.headers.get("accept"))) return streamed(tool, input.value, request);
  const host: HttpHost = { http: true, request };
  const settled = await settle(tool, input.value, { signal: request.signal, host });
  const { status, body } = encoded(tool, settled, false);
  return new Response(body, { status, headers: { "content-type": "application/json" } });
}

/**
 * Whether `Accept` names `text/event-stream`, without `q=0`.
 *
 * @param accept - The header, absent when the client sent none.
 * @returns {boolean} Whether to answer with events.
 */
function wantsStream(accept: string | null): boolean {
  return (accept ?? "").split(",").some((range) => {
    const [type, ...params] = range.split(";").map((part) => part.trim().toLowerCase());
    return type === "text/event-stream" && !params.some((param) => /^q=0(?:\.0*)?$/u.test(param));
  });
}

/** How a call ended, before it becomes text. */
interface Settled {
  readonly status: number;
  readonly body: HttpAnswer | HttpRefusal;
}

/**
 * Runs the call and turns any throw into a status.
 *
 * @param tool - Tool to run.
 * @param input - The parsed body.
 * @param context - Signal, host and, for a stream, progress.
 * @returns {Promise<Settled>} The answer, or why there is none.
 */
async function settle(
  tool: ToolDefinition,
  input: unknown,
  context: ToolCallContext,
): Promise<Settled> {
  try {
    const result = await invokeTool(tool, input, context);
    return { status: result.isError === true ? 422 : 200, body: answerOf(result) };
  } catch (error) {
    return failure(tool, error);
  }
}

/**
 * A throw as a refusal: 400 for bad input, else 500.
 *
 * @param tool - The tool that threw.
 * @param error - What it threw.
 * @returns {Settled} The refusal.
 */
function failure(tool: ToolDefinition, error: unknown): Settled {
  if (error instanceof ToolInputError) return refused(400, ...error.lines);
  const message = error instanceof Error ? error.message : String(error);
  return refused(500, `${tool.name} failed: ${message}`, ...causeLines(error));
}

/**
 * The ending as JSON text. Details that won't serialize become a 500.
 *
 * @param tool - The tool behind the answer.
 * @param settled - How the call ended.
 * @param withStatus - Whether the status goes into the body too.
 * @returns {{ status: number; body: string }} The status and the JSON text.
 */
function encoded(
  tool: ToolDefinition,
  settled: Settled,
  withStatus: boolean,
): { status: number; body: string } {
  const text = (ending: Settled): string =>
    JSON.stringify(withStatus ? { status: ending.status, ...ending.body } : ending.body);
  try {
    return { status: settled.status, body: text(settled) };
  } catch (error) {
    const fallback = failure(tool, error);
    return { status: fallback.status, body: text(fallback) };
  }
}

/**
 * Answers with `progress` events, then `result`. A client that leaves cancels a read.
 *
 * @param tool - Tool to run.
 * @param input - The parsed body.
 * @param request - The incoming request, for its signal and as the host.
 * @returns {Response} A `text/event-stream` that ends with the answer.
 */
function streamed(tool: ToolDefinition, input: unknown, request: Request): Response {
  const left = new AbortController();
  const signal = AbortSignal.any([request.signal, left.signal]);
  const host: HttpHost = { http: true, request };
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: string, data: string): void => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${data}\n\n`));
      };
      const progress = (message: string, amount?: ToolProgress): void => {
        send("progress", JSON.stringify(progressOf(message, amount)));
      };
      void settle(tool, input, { signal, host, progress }).then((settled) => {
        try {
          send("result", encoded(tool, settled, true).body);
          controller.close();
        } catch {}
      });
    },
    cancel(reason) {
      left.abort(reason);
    },
  });
  const headers = { "content-type": "text/event-stream", "cache-control": "no-cache" };
  return new Response(body, { headers });
}

/**
 * One progress event, with numbers only when they are numbers.
 *
 * @param message - The line, already cleaned by `invokeTool`.
 * @param amount - How far along, when the tool knows.
 * @returns {HttpProgress} The event body.
 */
function progressOf(message: string, amount: ToolProgress | undefined): HttpProgress {
  const progress = amount?.progress;
  const total = amount?.total;
  return {
    message,
    ...(Number.isFinite(progress) ? { progress } : {}),
    ...(Number.isFinite(total) ? { total } : {}),
  };
}

/**
 * Whether the body is declared JSON, which no page can do cross origin without a preflight.
 *
 * @param type - The header, absent when the client sent none.
 * @returns {boolean} Whether the body is declared as JSON.
 */
function isJson(type: string | null): boolean {
  return type?.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}

/** The parsed body, or the status and line that say why there is none. */
type ReadInput = { ok: true; value: unknown } | { ok: false; status: 400 | 413; line: string };

/**
 * The body as JSON, an empty one as `{}`.
 *
 * @param request - The incoming request.
 * @param limit - The body cap in bytes.
 * @returns {Promise<ReadInput>} The input, or why not.
 */
async function readInput(request: Request, limit: number): Promise<ReadInput> {
  try {
    const body = await readBody(request, limit);
    if (body === undefined) return { ok: false, status: 413, line: `Body is over ${limit} bytes` };
    return { ok: true, value: body.trim() === "" ? {} : JSON.parse(body) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, status: 400, line: `Body is not JSON: ${message}` };
  }
}

/**
 * The body as text, read only up to the cap, so a huge one never lands in memory.
 *
 * @param request - The incoming request.
 * @param limit - The body cap in bytes.
 * @returns {Promise<string | undefined>} The text, or `undefined` past the cap.
 */
async function readBody(request: Request, limit: number): Promise<string | undefined> {
  if (Number(request.headers.get("content-length")) > limit) return undefined;
  const reader = request.body?.getReader();
  if (reader === undefined) return "";
  const decoder = new TextDecoder();
  let text = "";
  let size = 0;
  for (let read = await reader.read(); !read.done; read = await reader.read()) {
    size += read.value.byteLength;
    if (size > limit) {
      void reader.cancel().catch(() => undefined);
      return undefined;
    }
    text += decoder.decode(read.value, { stream: true });
  }
  return text + decoder.decode();
}

/**
 * The tool's result as the answer body.
 *
 * @param result - What the tool returned.
 * @returns {HttpAnswer} The text, the details and any images.
 */
function answerOf(result: ToolResult): HttpAnswer {
  const images = result.content.flatMap((block) =>
    block.type === "image" ? [{ data: block.data, mimeType: block.mimeType }] : [],
  );
  const body: HttpAnswer = {
    text: resultText(result),
    details: result.details ?? null,
    ...(images.length > 0 ? { images } : {}),
  };
  return body;
}

/**
 * A refusal with each line cleaned on its own, as MCP's `errorResult` does.
 *
 * @param status - HTTP status.
 * @param lines - Why, one line each.
 * @returns {Settled} The status and the {@link HttpRefusal}.
 */
function refused(status: number, ...lines: readonly string[]): Settled {
  const body: HttpRefusal = { lines: lines.map(sanitizeLine) };
  return { status, body };
}

/**
 * A refusal before the call starts, plain JSON even for a stream.
 *
 * @param status - HTTP status.
 * @param lines - Why, one line each.
 * @returns {Response} The {@link HttpRefusal}.
 */
function refusal(status: number, ...lines: readonly string[]): Response {
  const { body } = refused(status, ...lines);
  return Response.json(body, { status });
}

/**
 * A 405 that names the method the path takes.
 *
 * @param allow - The one method that works there.
 * @returns {Response} The refusal with an `Allow` header.
 */
function wrongMethod(allow: "GET" | "POST"): Response {
  const body: HttpRefusal = { lines: [`Use ${allow} here`] };
  return Response.json(body, { status: 405, headers: { allow } });
}
