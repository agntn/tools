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
  ToolDefinition as PiToolDefinition,
} from "@earendil-works/pi-coding-agent";

import {
  invokeTool,
  resultText,
  sanitizeLine,
  ToolDefinitionError,
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
 * @param options - Failure policy, host `Text` and renderers.
 * @throws {ToolDefinitionError} When a tool has `describeCall` but no `Text` came with it.
 */
export function registerPiTools(
  pi: ExtensionAPI,
  tools: readonly ToolDefinition[],
  options: PiToolOptions = {},
): void {
  const failures = options.failures ?? "throw";

  for (const tool of tools) {
    const renderers = Object.hasOwn(options.renderers ?? {}, tool.name)
      ? options.renderers?.[tool.name]
      : undefined;
    pi.registerTool({
      ...hostRenderers(tool, renderers, options.Text),
      name: tool.name,
      label: tool.title,
      description: tool.description,
      ...(tool.snippet === undefined ? {} : { promptSnippet: tool.snippet }),
      ...(tool.guidelines === undefined ? {} : { promptGuidelines: [...tool.guidelines] }),
      parameters: tool.input,
      async execute(_toolCallId, params, signal): Promise<AgentToolResult<unknown>> {
        const result = await invokeTool(tool, params, signal ? { signal } : {});
        if (result.isError && failures === "throw") throw new Error(resultText(result));
        return result;
      },
    });
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
