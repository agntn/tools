/**
 * OpenCode adapter: registers {@link ToolDefinition}s from a plugin's `setup`.
 *
 * Only types come from `@opencode/plugin`; the host hands over everything else at runtime.
 */

import type { Plugin } from "@opencode/plugin";
import type { Info, Result, ToolContext } from "@opencode/plugin/promise/tool";

import { throwWithCauses } from "./causes.ts";
import {
  indexTools,
  invokeTool,
  resultText,
  ToolInputError,
  validateInput,
  wireSchema,
  type ToolCallContext,
  type ToolContent,
  type ToolDefinition,
  type ToolResult,
} from "./index.ts";

/** One block of what the model reads, as OpenCode takes it. */
type OpencodeContent = Exclude<Result["content"], string | undefined>[number];

/**
 * Registers every tool on the plugin's context.
 *
 * A tool that isn't a `read` meets OpenCode's permission rules under its own name, like an MCP
 * tool, so `"<name>": "ask"` in `opencode.json` asks every time. An `isError` result throws.
 *
 * @param ctx - The context `setup` gets.
 * @param tools - Tools to register.
 * @returns {Promise<void>} Once OpenCode has the tools.
 * @throws {ToolDefinitionError} When two tools share a name.
 */
export async function registerOpencodeTools(
  ctx: Plugin.Context,
  tools: readonly ToolDefinition[],
): Promise<void> {
  indexTools(tools);
  await ctx.tool.transform((editor) => {
    for (const tool of tools) editor.add(opencodeTool(ctx, tool));
  });
}

/**
 * @param ctx - Plugin context, for the permission check.
 * @param tool - Tool to register.
 * @returns {Info} What `editor.add` takes.
 */
function opencodeTool(ctx: Plugin.Context, tool: ToolDefinition): Info {
  return {
    name: tool.name,
    description: tool.description,
    input: wireSchema(tool),
    async execute(input, context): Promise<Result> {
      if (tool.effect !== "read") await approve(ctx, tool, input, context);
      const result = await invokeTool(tool, input, callContext(context)).catch(throwWithCauses);
      if (result.isError) throw new Error(resultText(result));
      return opencodeResult(result);
    },
  };
}

/**
 * Asks OpenCode whether the call may run, after the arguments pass, so nobody approves a typo.
 *
 * @param ctx - Plugin context.
 * @param tool - Tool being called.
 * @param input - Arguments as OpenCode passes them.
 * @param context - OpenCode's context of the call.
 * @returns {Promise<void>} Once the rules or the user allow it.
 * @throws {ToolInputError} When the arguments fail the schema.
 * @throws {unknown} Whatever OpenCode rejects with on a deny or a "no", passed on untouched.
 */
async function approve(
  ctx: Plugin.Context,
  tool: ToolDefinition,
  input: unknown,
  context: ToolContext,
): Promise<void> {
  const checked = validateInput(tool, input);
  if (!checked.ok) throw new ToolInputError(checked.lines, checked.issues, tool.name);
  await ctx.permission.assert({
    sessionID: context.sessionID,
    agent: context.agent,
    action: tool.name,
    resources: ["*"],
    save: ["*"],
    metadata: { input: checked.value },
    source: { type: "tool", messageID: context.messageID, id: context.id },
  });
}

/**
 * Hands the call's signal and progress to the tool, with OpenCode's context as `host`.
 *
 * @param context - OpenCode's context of the call.
 * @returns {ToolCallContext} Context for `invokeTool`.
 */
function callContext(context: ToolContext): ToolCallContext {
  return {
    signal: context.signal,
    host: context,
    progress(message, amount): void {
      void context.progress({ message, ...amount }).catch(() => undefined);
    },
  };
}

/**
 * Images become data URIs and the details `metadata`.
 * No blocks go out as `""`, since OpenCode shows the model an empty list as "undefined".
 *
 * @param result - Result of a call that did not fail.
 * @returns {Result} What OpenCode records for the call.
 */
function opencodeResult(result: ToolResult): Result {
  const content = result.content.map(opencodeContent);
  return {
    content: content.length > 0 ? content : "",
    ...metadata(result.details),
  };
}

/**
 * @param block - One block of the result.
 * @returns {OpencodeContent} The same block in OpenCode's shape.
 */
function opencodeContent(block: Readonly<ToolContent>): OpencodeContent {
  if (block.type === "text") return { type: "text", text: block.text };
  return { type: "file", uri: `data:${block.mimeType};base64,${block.data}`, mime: block.mimeType };
}

/**
 * @param details - The result's details.
 * @returns {Pick<Result, "metadata">} An object as it is, anything else under `details`.
 */
function metadata(details: unknown): Pick<Result, "metadata"> {
  if (details === undefined) return {};
  const plain = typeof details === "object" && details !== null && !Array.isArray(details);
  return { metadata: plain ? (details as Readonly<Record<string, unknown>>) : { details } };
}
