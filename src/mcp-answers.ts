/**
 * What `tools/list` and `tools/call` answer, without the MCP SDK at runtime.
 *
 * Shared by the `Server` in `mcp.ts` and the h3-mcp adapter in `h3.ts`, so a
 * transport that brings its own JSON-RPC layer never loads the SDK.
 */

import type {
  CallToolResult,
  ElicitRequestFormParams,
  InputRequiredResult,
  Tool,
  ToolAnnotations,
} from "@modelcontextprotocol/server";
import { Value } from "typebox/value";

import {
  indexTools,
  invokeTool,
  sanitizeLine,
  ToolInputError,
  wireSchema,
  type Icon,
  type ToolAsk,
  type ToolCallContext,
  type ToolDefinition,
  type ToolResult,
} from "./index.ts";
import { hostAsk, readAnswer, type HostQuestion } from "./questions.ts";

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
 * @returns {Tool[]} Name, title, description, icons, schemas, annotations and `_meta` of each tool.
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
    ...(tool.output === undefined
      ? {}
      : { outputSchema: { ...tool.output } as NonNullable<Tool["outputSchema"]> }),
    annotations: toolAnnotations(tool),
    ...(tool.meta === undefined ? {} : { _meta: { ...tool.meta } }),
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
    return answer(tool, await invokeTool(tool, args, context));
  } catch (error) {
    if (error instanceof ToolInputError) return errorResult(...error.lines);
    return errorResult(
      `${tool.name} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * The result as MCP carries it, with `details` as `structuredContent` once they pass `output`.
 *
 * @param tool - Tool that answered.
 * @param result - Its result.
 * @returns {CallToolResult} Text, and the checked details when the tool declares their shape.
 */
function answer(tool: ToolDefinition, result: ToolResult): CallToolResult {
  const content = {
    content: result.content,
    ...(result.isError === undefined ? {} : { isError: result.isError }),
  };
  if (tool.output === undefined || result.isError === true) return content;
  if (Value.Check(tool.output, result.details)) {
    return { ...content, structuredContent: result.details as Record<string, unknown> };
  }
  return errorResult(
    `${tool.name} returned details that don't match its output schema`,
    ...[...Value.Errors(tool.output, result.details)].map(
      (failure) => `at ${failure.instancePath || "/"}: ${failure.message}`,
    ),
  );
}

/** One pass of a call over MCP: the `ask` for `execute`, and the question it stopped on, if any. */
export interface QuestionRound {
  readonly ask: ToolAsk;
  readonly pending: () => InputRequiredResult | undefined;
  /** Settles the moment the call stops on a question it has no answer for. */
  readonly stopped: () => Promise<void>;
}

/**
 * Answers questions from what the client sent back, and stops the call at the first one it lacks.
 *
 * MCP has no way to pause a call: the server returns `input_required` and the
 * client calls again with the answer. So every answer so far rides in
 * `requestState`, the next one in `inputResponses` under `ask-<n>`, and
 * `execute` runs from the top with each one replayed in order. A reply that
 * doesn't fit its question, from a client or a tampered state, is asked again,
 * and so is one whose question has changed since: each answer keeps its question's fingerprint.
 * The state needs no signature: whoever could forge it could forge the reply.
 *
 * A question without its answer never settles, so no `catch` around it lets the call run on.
 *
 * @param responses - The retry's `inputResponses`, absent on the first pass.
 * @param state - The retry's `requestState`, absent on the first pass.
 * @returns {QuestionRound} The `ask`, the question to send and the moment the call stopped.
 */
export function questionRound(
  responses: Readonly<Record<string, unknown>> | undefined,
  state: string | undefined,
): QuestionRound {
  const read = readState(state);
  const answers = [...read.answers];
  const { asking } = read;
  const { promise: stopped, resolve: stop } = Promise.withResolvers<void>();
  let asked = 0;
  let turn: Promise<unknown> = Promise.resolve();
  let pending: InputRequiredResult | undefined;
  const settle = async (index: number, question: HostQuestion): Promise<unknown> => {
    const print = await fingerprint(question);
    if (pending !== undefined || index > answers.length) return await hold();
    const known =
      index < answers.length ? answers[index] : { q: asking, a: responses?.[`ask-${index}`] };
    const answer = known?.q === print ? readAnswer(question, known.a) : undefined;
    if (answer) {
      answers[index] = { q: print, a: answer };
      return answer;
    }
    pending = inputRequired(index, question, { answers: answers.slice(0, index), asking: print });
    stop();
    return await hold();
  };
  const ask = hostAsk(async (question) => {
    const index = asked++;
    const reply = turn.then(async () => await settle(index, question));
    turn = reply.catch(() => undefined);
    return await reply;
  });
  return { ask, pending: () => pending, stopped: async () => await stopped };
}

/**
 * A promise that never settles: the call stays where it asked, whatever `catch` sits around it.
 *
 * @returns {Promise<never>} Nothing, ever.
 */
async function hold(): Promise<never> {
  return await new Promise<never>(() => {});
}

/** One replayed answer and the fingerprint of the question it answered. */
interface Answered {
  readonly q: string;
  readonly a: unknown;
}

/** What `requestState` carries: every answer so far, and which question is out. */
interface RoundState {
  readonly answers: readonly Answered[];
  readonly asking?: string;
}

/**
 * The SHA-256 of a question's message and form, so no answer lands on a changed question.
 *
 * @param question - The question, its message cleaned.
 * @returns {Promise<string>} The digest in hex.
 */
async function fingerprint(question: HostQuestion): Promise<string> {
  const text = JSON.stringify([question.message, question.requested]);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Answers one call as `callTool` does, or with `input_required` once it stops on a question.
 *
 * The stopped call is left hanging where it asked, and its signal aborts, so
 * work it started next to the question winds down instead of running on.
 * Progress goes quiet at the same moment.
 *
 * @param info - Server info; `name` is the word in the message for an unknown tool.
 * @param tools - Tools to look the name up in.
 * @param name - Tool name as the client sent it.
 * @param args - Arguments as the client sent them.
 * @param context - Context for this call, without `ask`.
 * @param round - The round of questions, when the client can answer one.
 * @returns {Promise<CallToolResult | InputRequiredResult>} The answer, or the question to send.
 */
export async function callAsking(
  info: Pick<McpServerInfo, "name">,
  tools: readonly ToolDefinition[],
  name: string,
  args: unknown,
  context: ToolCallContext,
  round: QuestionRound | undefined,
): Promise<CallToolResult | InputRequiredResult> {
  if (!round) return await callTool(info, tools, name, args, context);
  const halt = new AbortController();
  const { progress, signal } = context;
  const call = callTool(info, tools, name, args, {
    ...context,
    signal: signal ? AbortSignal.any([signal, halt.signal]) : halt.signal,
    ...(progress ? { progress: quietOnQuestion(progress, round) } : {}),
    ask: round.ask,
  });
  const result = await Promise.race([call, round.stopped()]);
  const pending = round.pending();
  if (pending === undefined && result !== undefined) return result;
  halt.abort(new Error("The call stopped to wait for the user"));
  return pending ?? (await call);
}

/**
 * Progress that stops once the call has stopped on a question, since that request has its answer.
 *
 * @param progress - The transport's callback.
 * @param round - The round that may stop the call.
 * @returns {NonNullable<ToolCallContext["progress"]>} The callback for `execute`.
 */
function quietOnQuestion(
  progress: NonNullable<ToolCallContext["progress"]>,
  round: QuestionRound,
): NonNullable<ToolCallContext["progress"]> {
  return (message, amount) => {
    if (round.pending() === undefined) progress(message, amount);
  };
}

/**
 * The `input_required` result for one question.
 *
 * @param index - Its place among the call's questions.
 * @param question - The question, its message cleaned.
 * @param state - Every answer before it, and this question's fingerprint.
 * @returns {InputRequiredResult} What the client gets instead of a result.
 */
function inputRequired(
  index: number,
  question: HostQuestion,
  state: RoundState,
): InputRequiredResult {
  const { message, requested } = question;
  return {
    resultType: "input_required",
    inputRequests: {
      [`ask-${index}`]: {
        method: "elicitation/create",
        params: {
          mode: "form",
          message,
          requestedSchema: requested as ElicitRequestFormParams["requestedSchema"],
        },
      },
    },
    requestState: JSON.stringify(state),
  };
}

/**
 * What a `requestState` carries. Anything else carries nothing, and every question is asked again.
 *
 * @param state - The echoed state.
 * @returns {RoundState} Answers in order, each still to be checked against its question.
 */
function readState(state: string | undefined): RoundState {
  try {
    const parsed: unknown = JSON.parse(state ?? "{}");
    const { answers, asking } = (parsed ?? {}) as { answers?: unknown; asking?: unknown };
    return {
      answers: Array.isArray(answers) ? answers.filter(isAnswered) : [],
      ...(typeof asking === "string" ? { asking } : {}),
    };
  } catch {
    return { answers: [] };
  }
}

/**
 * Whether a state entry has the shape of a replayed answer.
 *
 * @param entry - One entry of `answers`.
 * @returns {boolean} Whether it has a fingerprint next to its answer.
 */
function isAnswered(entry: unknown): entry is Answered {
  return typeof entry === "object" && entry !== null && typeof (entry as Answered).q === "string";
}

/**
 * Whether a client can fill a form: `elicitation.form`, or a bare `elicitation`, which means form.
 *
 * @param capabilities - What the client declared.
 * @returns {boolean} Whether an `ask` can reach it.
 */
export function canAsk(capabilities: unknown): boolean {
  if (typeof capabilities !== "object" || capabilities === null) return false;
  const { elicitation } = capabilities as { readonly elicitation?: unknown };
  if (typeof elicitation !== "object" || elicitation === null) return false;
  const modes = elicitation as { readonly form?: unknown; readonly url?: unknown };
  return modes.form !== undefined || modes.url === undefined;
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
