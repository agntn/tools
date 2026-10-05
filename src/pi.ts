/**
 * Pi adapter: registers {@link ToolDefinition}s on a Pi `ExtensionAPI`.
 *
 * Only types come from `@earendil-works/pi-coding-agent`; nothing is imported
 * from the host at runtime. A call line from `describeCall` needs the host
 * `Text`, which the extension passes in.
 */

import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition as PiToolDefinition,
} from "@earendil-works/pi-coding-agent";

import { sanitizeText } from "./escapes.ts";
import {
  invokeTool,
  resultText,
  sanitizeLine,
  ToolDefinitionError,
  ToolInputError,
  validateInput,
  type ToolDefinition,
} from "./index.ts";

type Component = ReturnType<NonNullable<PiToolDefinition["renderCall"]>>;

/** The `Text` component of `@earendil-works/pi-tui`, which Pi resolves for every extension. */
export type PiTextComponent = new (text: string, paddingX: number, paddingY: number) => Component;

export interface PiToolOptions {
  /**
   * How a returned `isError` result reaches Pi.
   *
   * `throw` (default) raises the result text: `pi-agent-core` up to 0.98 marks
   * every returned object as a success and records an error only after a throw.
   * `return` hands the result over unchanged and keeps its `details`; use it
   * only with a peer range of `>=0.99.0`, since Pi does not check peer ranges.
   */
  readonly failures?: "throw" | "return";
  /** Host `Text` from `@earendil-works/pi-tui`, which `describeCall` draws with. */
  readonly Text?: PiTextComponent;
  /** Renderers by tool name. */
  readonly renderers?: Readonly<Record<string, PiRenderers>>;
  /** Questions to ask before a call runs, by tool name. A name off the tool list throws. */
  readonly confirm?: Readonly<Record<string, PiConfirm>>;
}

/** Builds the question for one call from its validated input; `undefined` skips it. */
export type PiConfirm = (
  input: Readonly<Record<string, unknown>>,
) => PiQuestion | undefined | Promise<PiQuestion | undefined>;

/** What `ctx.ui.confirm` shows. The adapter sanitizes both and keeps the message's lines. */
export interface PiQuestion {
  readonly title: string;
  readonly message: string;
}

/** Renderers for one tool: Pi's own, passed unchanged, or a one-line call summary. */
export interface PiRenderers extends Readonly<
  Pick<PiToolDefinition, "renderCall" | "renderResult">
> {
  /** One-line summary of the arguments after the title, sanitized here. A `renderCall` wins. */
  readonly describeCall?: (args: Readonly<Record<string, unknown>>) => unknown;
}

/**
 * Registers every tool on the Pi extension API.
 *
 * @param pi - Pi extension API.
 * @param tools - Tools to register.
 * @param options - Failure policy, host `Text`, renderers and questions.
 * @throws {ToolDefinitionError} When a tool has `describeCall` but no `Text` came with it, or
 *   `confirm` names a tool that isn't in the list.
 */
export function registerPiTools(
  pi: ExtensionAPI,
  tools: readonly ToolDefinition[],
  options: PiToolOptions = {},
): void {
  const failures = options.failures ?? "throw";
  const stray = Object.keys(options.confirm ?? {}).find(
    (name) => !tools.some((t) => t.name === name),
  );
  if (stray !== undefined) {
    throw new ToolDefinitionError(
      `confirm names ${JSON.stringify(stray)}, which isn't in the tool list`,
    );
  }

  for (const tool of tools) {
    const renderers = byName(options.renderers, tool.name);
    const ask = byName(options.confirm, tool.name);
    pi.registerTool({
      ...hostRenderers(tool, renderers, options.Text),
      name: tool.name,
      label: tool.title,
      description: tool.description,
      ...(tool.snippet === undefined ? {} : { promptSnippet: tool.snippet }),
      ...(tool.guidelines === undefined ? {} : { promptGuidelines: [...tool.guidelines] }),
      parameters: tool.input,
      async execute(
        _toolCallId,
        params,
        signal,
        _onUpdate,
        ctx,
      ): Promise<AgentToolResult<unknown>> {
        if (ask) await approve(tool, ask, params, signal, ctx);
        const result = await invokeTool(tool, params, signal ? { signal } : {});
        if (result.isError && failures === "throw") throw new Error(resultText(result));
        return result;
      },
    });
  }
}

/**
 * Own entry of a by-name option, so a tool named `constructor` doesn't reach the prototype.
 *
 * @param entries - Option keyed by tool name.
 * @param name - Tool name.
 * @returns {T | undefined} The entry, if the option has one for this tool.
 */
function byName<T>(entries: Readonly<Record<string, T>> | undefined, name: string): T | undefined {
  return entries && Object.hasOwn(entries, name) ? entries[name] : undefined;
}

/**
 * Asks the user about one call and throws unless they say yes.
 *
 * @param tool - Tool being called.
 * @param ask - Its question builder.
 * @param params - Arguments as Pi passes them.
 * @param signal - The call's abort signal, which also dismisses the dialog.
 * @param ctx - Pi context of the call.
 * @returns {Promise<void>} Once the call may run.
 * @throws {ToolInputError} When the arguments fail the schema, before anyone is asked.
 * @throws {Error} Without a UI, on a "no", or with the reason of an abort.
 */
async function approve(
  tool: ToolDefinition,
  ask: PiConfirm,
  params: unknown,
  signal: AbortSignal | undefined,
  ctx: ExtensionContext,
): Promise<void> {
  const checked = validateInput(tool, params);
  if (!checked.ok) throw new ToolInputError(checked.lines);
  const question = await ask(checked.value);
  if (question === undefined) return;
  if (!ctx.hasUI) throw new Error(`${tool.name} needs interactive approval in Pi TUI or RPC mode`);
  const approved = await ctx.ui.confirm(
    sanitizeLine(question.title),
    sanitizeText(question.message),
    signal ? { signal } : {},
  );
  signal?.throwIfAborted();
  if (!approved) {
    throw new Error(
      `${tool.name} was cancelled by the user. Do not retry unless the user asks again.`,
    );
  }
}

/**
 * The renderers Pi gets for one tool, with `describeCall` turned into a `renderCall`.
 *
 * @param tool - Tool being registered.
 * @param renderers - Its renderers, if any.
 * @param Text - Host `Text` component.
 * @returns {Pick<PiToolDefinition, "renderCall" | "renderResult">} What goes to `pi.registerTool`.
 * @throws {ToolDefinitionError} When `describeCall` would draw but `Text` is missing.
 */
function hostRenderers(
  tool: ToolDefinition,
  renderers: PiRenderers | undefined,
  Text: PiTextComponent | undefined,
): Pick<PiToolDefinition, "renderCall" | "renderResult"> {
  if (!renderers) return {};
  const { describeCall, ...own } = renderers;
  if (own.renderCall || !describeCall) return own;
  if (!Text) throw new ToolDefinitionError(`${tool.name}: describeCall needs the host Text option`);
  const title = sanitizeLine(tool.title);
  return {
    ...own,
    renderCall(args, theme): Component {
      const summary = sanitizeLine(describeCall(args as Readonly<Record<string, unknown>>));
      const header = theme.fg("toolTitle", theme.bold(title));
      return new Text(summary ? `${header} ${theme.fg("muted", summary)}` : header, 0, 0);
    },
  };
}
