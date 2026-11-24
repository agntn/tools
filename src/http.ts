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
  type ToolDefinition,
  type ToolEffect,
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
  try {
    const host: HttpHost = { http: true, request };
    return answer(await invokeTool(tool, input.value, { signal: request.signal, host }));
  } catch (error) {
    if (error instanceof ToolInputError) return refusal(400, ...error.lines);
    const message = error instanceof Error ? error.message : String(error);
    return refusal(500, `${tool.name} failed: ${message}`, ...causeLines(error));
  }
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
      await reader.cancel();
      return undefined;
    }
    text += decoder.decode(read.value, { stream: true });
  }
  return text + decoder.decode();
}

/**
 * The tool's result as JSON: 200, or 422 for `isError`.
 *
 * @param result - What the tool returned.
 * @returns {Response} The text, the details and any images.
 */
function answer(result: ToolResult): Response {
  const images = result.content.flatMap((block) =>
    block.type === "image" ? [{ data: block.data, mimeType: block.mimeType }] : [],
  );
  const body: HttpAnswer = {
    text: resultText(result),
    details: result.details ?? null,
    ...(images.length > 0 ? { images } : {}),
  };
  return Response.json(body, { status: result.isError === true ? 422 : 200 });
}

/**
 * A refusal with each line cleaned on its own, as MCP's `errorResult` does.
 *
 * @param status - HTTP status.
 * @param lines - Why, one line each.
 * @returns {Response} The {@link HttpRefusal}.
 */
function refusal(status: number, ...lines: readonly string[]): Response {
  const body: HttpRefusal = { lines: lines.map(sanitizeLine) };
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
