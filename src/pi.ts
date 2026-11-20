/**
 * Pi adapter: registers {@link ToolDefinition}s on a Pi `ExtensionAPI`.
 *
 * Only types come from `@earendil-works/pi-coding-agent`; nothing is imported
 * from the host at runtime. A call line from `describeCall` needs the host
 * `Text`, which the extension passes in.
 */

import type { TSchema } from "typebox";
import { Value } from "typebox/value";

import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition as PiToolDefinition,
} from "@earendil-works/pi-coding-agent";

import { throwWithCauses } from "./causes.ts";
import { sanitizeText } from "./escapes.ts";
import {
  indexTools,
  invokeTool,
  resultText,
  sanitizeLine,
  ToolDefinitionError,
  ToolInputError,
  validateInput,
  type ToolDefinition,
} from "./index.ts";
import { hostContext } from "./updates.ts";

type Component = ReturnType<NonNullable<PiToolDefinition["renderCall"]>>;

/** Pi types the hook's result as the schema's shape, though it only ever feeds the validator. */
type PiPrepareHook = NonNullable<PiToolDefinition<ToolDefinition["input"]>["prepareArguments"]>;

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
  /** Pi's argument repair by tool name, run before validation. A name off the list throws. */
  readonly prepareArguments?: Readonly<Record<string, PiPrepareArguments>>;
  /** How the model reaches the tools, for all or by name. Left out, Pi's `direct`. */
  readonly exposure?: PiToolExposure | PiExposures;
  /** Group the tools share, as Pi groups the tools of one MCP server. */
  readonly namespace?: PiToolNamespace;
}

/** Pi's `ToolExposure`, spelled out so older Pi types still compile. */
export type PiToolExposure = "direct" | "model-only" | "codemode" | "deferred" | "hidden";

/** Exposure by tool name, with a fallback for the rest. A name off the list throws. */
export interface PiExposures {
  readonly default?: PiToolExposure;
  readonly tools?: Readonly<Record<string, PiToolExposure>>;
}

/** Pi's `ToolNamespace`: what `describeNamespace()` and `tool_search` read. */
export interface PiToolNamespace {
  readonly name: string;
  readonly description?: string;
  readonly instructions?: string;
}

const EXPOSURES: readonly string[] = ["direct", "model-only", "codemode", "deferred", "hidden"];

/** The user's pick for every package; `AGNTN_PI_EXPOSURE_KEYS` beats it for `keys_*` tools. */
const EXPOSURE_VARIABLE = "AGNTN_PI_EXPOSURE";

/** Repairs raw model input before validation. Hand back what it doesn't recognise untouched. */
export type PiPrepareArguments = (args: unknown) => unknown;

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
 * @param options - Failure policy, host `Text`, renderers, questions, repairs and exposure.
 * @throws {ToolDefinitionError} When two tools share a name, a tool has `describeCall` but no
 *   `Text` came with it, `confirm`, `prepareArguments` or `exposure` names a tool that isn't in
 *   the list, or an exposure isn't one Pi knows.
 */
export function registerPiTools(
  pi: ExtensionAPI,
  tools: readonly ToolDefinition[],
  options: PiToolOptions = {},
): void {
  const names = [...indexTools(tools).keys()];
  const failures = options.failures ?? "throw";
  refuseStray(names, "confirm", options.confirm);
  refuseStray(names, "prepareArguments", options.prepareArguments);
  checkOption(names, options.exposure);
  fromEnvironment(EXPOSURE_VARIABLE);

  for (const tool of tools) {
    const renderers = byName(options.renderers, tool.name);
    const ask = byName(options.confirm, tool.name);
    const prepare = parseJsonText(tool, byName(options.prepareArguments, tool.name));
    pi.registerTool({
      ...hostRenderers(tool, renderers, options.Text),
      prepareArguments: prepare as PiPrepareHook,
      name: tool.name,
      label: tool.title,
      description: tool.description,
      ...(tool.snippet === undefined ? {} : { promptSnippet: tool.snippet }),
      ...(tool.guidelines === undefined ? {} : { promptGuidelines: [...tool.guidelines] }),
      parameters: tool.input,
      ...reach(tool.name, options),
      async execute(_toolCallId, params, signal, onUpdate, ctx): Promise<AgentToolResult<unknown>> {
        if (ask) await approve(tool, ask, params, signal, ctx);
        const context = hostContext(signal, onUpdate, ctx);
        const result = await invokeTool(tool, params, context).catch(throwWithCauses);
        if (result.isError && failures === "throw") throw new Error(resultText(result));
        return result;
      },
    });
  }
}

/**
 * Parses arrays and objects sent as JSON text before Pi 1.5 wraps or refuses them.
 *
 * @param tool - Tool being registered.
 * @param own - The caller's repair for it, if any.
 * @returns {PiPrepareArguments} The repair Pi runs before validation.
 */
function parseJsonText(
  tool: ToolDefinition,
  own: PiPrepareArguments | undefined,
): PiPrepareArguments {
  if (own === undefined) return (args) => repairJsonText(tool, args);
  return (args) => own(repairJsonText(tool, args));
}

/**
 * @param tool - Tool whose top-level properties may hold JSON text.
 * @param args - Raw arguments from the model.
 * @returns {unknown} A copy with each JSON text its schema accepts parsed, or `args` itself.
 */
function repairJsonText(tool: ToolDefinition, args: unknown): unknown {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return args;
  const raw = args as Readonly<Record<string, unknown>>;
  let repaired: Record<string, unknown> | undefined;
  const properties: readonly [string, TSchema][] = Object.entries(tool.input.properties);
  for (const [key, schema] of properties) {
    const parsed = Object.hasOwn(raw, key) ? jsonValue(raw[key], schema) : undefined;
    if (parsed === undefined) continue;
    repaired ??= { ...raw };
    repaired[key] = parsed;
  }
  return repaired ?? args;
}

/**
 * @param value - One argument as the model sent it.
 * @param schema - Schema of its property.
 * @returns {unknown} The array or object the text spells, if the schema takes it.
 */
function jsonValue(value: unknown, schema: TSchema): unknown {
  if (typeof value !== "string" || !/^\s*[[{]/.test(value)) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && Value.Check(schema, parsed)
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * @param name - Tool name.
 * @param options - Adapter options.
 * @returns {Pick<PiToolDefinition, "exposure" | "namespace">} Only the fields that are set.
 */
function reach(
  name: string,
  options: PiToolOptions,
): Pick<PiToolDefinition, "exposure" | "namespace"> {
  const exposure = exposureOf(name, options.exposure);
  return {
    ...(exposure === undefined ? {} : { exposure }),
    ...(options.namespace === undefined ? {} : { namespace: { ...options.namespace } }),
  };
}

/**
 * The user's environment first, then the package's option.
 *
 * @param name - Tool name; the part before its first `_` names the package's variable.
 * @param option - The `exposure` option.
 * @returns {PiToolExposure | undefined} The exposure, or `undefined` to leave Pi's default.
 * @throws {ToolDefinitionError} On a value Pi doesn't know.
 */
function exposureOf(
  name: string,
  option: PiToolExposure | PiExposures | undefined,
): PiToolExposure | undefined {
  const own = `${EXPOSURE_VARIABLE}_${name.split("_", 1)[0]?.toUpperCase() ?? ""}`;
  const picked =
    fromEnvironment(own) ??
    fromEnvironment(EXPOSURE_VARIABLE) ??
    (typeof option === "object" ? (byName(option.tools, name) ?? option.default) : option);
  return picked;
}

/**
 * Checks every value of the option up front, so an empty tool list can't hide a typo.
 *
 * @param names - Names of the registered tools.
 * @param option - The `exposure` option.
 * @throws {ToolDefinitionError} On a stray name or a value Pi doesn't know.
 */
function checkOption(names: readonly string[], option: PiToolOptions["exposure"]): void {
  if (typeof option !== "object") {
    if (option !== undefined) checkExposure(option, "exposure");
    return;
  }
  refuseStray(names, "exposure.tools", option.tools);
  if (option.default !== undefined) checkExposure(option.default, "exposure.default");
  for (const [name, value] of Object.entries(option.tools ?? {})) {
    checkExposure(value, `exposure of ${name}`);
  }
}

/**
 * @param variable - Environment variable name.
 * @returns {PiToolExposure | undefined} Its exposure; empty or unset reads as none.
 * @throws {ToolDefinitionError} On a value Pi doesn't know.
 */
function fromEnvironment(variable: string): PiToolExposure | undefined {
  const value = typeof process === "undefined" ? undefined : process.env[variable];
  return value ? checkExposure(value, variable) : undefined;
}

/**
 * @param value - Exposure as written.
 * @param where - Where it came from, for the message.
 * @returns {PiToolExposure} The value, once Pi would know it.
 * @throws {ToolDefinitionError} When it isn't one of Pi's exposures.
 */
function checkExposure(value: unknown, where: string): PiToolExposure {
  if (typeof value === "string" && EXPOSURES.includes(value)) return value as PiToolExposure;
  const shown = typeof value === "string" ? `is ${JSON.stringify(value)}` : "isn't a string";
  throw new ToolDefinitionError(`${where} ${shown}; takes ${EXPOSURES.join(", ")}`);
}

/**
 * Throws when an option names an unregistered tool, since a typo would drop its entry silently.
 *
 * @param names - Names of the registered tools.
 * @param option - Option name, for the message.
 * @param entries - Option keyed by tool name.
 * @throws {ToolDefinitionError} On the first name off the tool list.
 */
function refuseStray(
  names: readonly string[],
  option: string,
  entries: Readonly<Record<string, unknown>> | undefined,
): void {
  const stray = Object.keys(entries ?? {}).find((name) => !names.includes(name));
  if (stray === undefined) return;
  throw new ToolDefinitionError(
    `${option} names ${JSON.stringify(stray)}, which isn't in the tool list`,
  );
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
  if (!checked.ok) throw new ToolInputError(checked.lines, checked.issues, tool.name);
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
