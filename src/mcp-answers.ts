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
}

/**
 * Answers questions from what the client sent back, and stops the call at the first one it lacks.
 *
 * MCP has no way to pause a call: the server returns `input_required` and the
 * client calls again with the answer. So every answer so far rides in
 * `requestState`, the next one in `inputResponses` under `ask-<n>`, and
 * `execute` runs from the top with each one replayed in order. A reply that
 * doesn't fit its question, from a client or a tampered state, is asked again.
 * The state needs no signature: whoever could forge it could forge the reply.
 *
 * @param responses - The retry's `inputResponses`, absent on the first pass.
 * @param state - The retry's `requestState`, absent on the first pass.
 * @returns {QuestionRound} The `ask` and the question to send, once the call has run.
 */
export function questionRound(
  responses: Readonly<Record<string, unknown>> | undefined,
  state: string | undefined,
): QuestionRound {
  const answers = readState(state);
  let asked = 0;
  let pending: InputRequiredResult | undefined;
  const ask = hostAsk(async (question) => {
    const index = asked++;
    if (pending === undefined && index <= answers.length) {
      const reply = index < answers.length ? answers[index] : responses?.[`ask-${index}`];
      const answer = readAnswer(question, reply);
      if (answer) {
        answers[index] = answer;
        return answer;
      }
      pending = inputRequired(index, question, answers.slice(0, index));
    }
    throw new Error("Waiting for the user to answer");
  });
  return { ask, pending: () => pending };
}

/**
 * The `input_required` result for one question.
 *
 * @param index - Its place among the call's questions.
 * @param question - The question, its message cleaned.
 * @param answers - Every answer before it.
 * @returns {InputRequiredResult} What the client gets instead of a result.
 */
function inputRequired(
  index: number,
  question: HostQuestion,
  answers: readonly unknown[],
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
    requestState: JSON.stringify(answers),
  };
}

/**
 * The answers a `requestState` carries. Anything but a JSON array carries none.
 *
 * @param state - The echoed state.
 * @returns {unknown[]} Replies in order, each still to be checked against its question.
 */
function readState(state: string | undefined): unknown[] {
  if (state === undefined) return [];
  try {
    const answers: unknown = JSON.parse(state);
    return Array.isArray(answers) ? answers : [];
  } catch {
    return [];
  }
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
