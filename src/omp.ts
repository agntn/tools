/**
 * OMP adapter: registers {@link ToolDefinition}s on an OMP `ExtensionAPI`.
 *
 * Only types come from `@oh-my-pi/pi-coding-agent`. Compiled OMP injects the
 * package root into the extension file itself, not into its dependencies, so
 * the extension passes the host `Text` component in.
 */

import type {
  AgentToolResult,
  ExtensionAPI,
  Text as HostText,
  Theme,
  ToolDefinition as OmpToolDefinition,
  ToolRenderResultOptions,
} from "@oh-my-pi/pi-coding-agent";

import { throwWithCauses } from "./causes.ts";
import { sanitizeText } from "./escapes.ts";
import {
  indexTools,
  invokeTool,
  sanitizeLine,
  wireSchema,
  type ToolDefinition,
  type ToolEffect,
} from "./index.ts";
import { hostContext } from "./updates.ts";

type TextComponent = typeof HostText;
type Component = ReturnType<NonNullable<OmpToolDefinition["renderCall"]>>;

/** The part of a host result a renderer reads. */
export interface OmpResultView {
  readonly details?: unknown;
  readonly isError?: boolean;
}

/** Per-tool renderer overrides, drawn with the host theme. */
export interface OmpRenderers {
  /** One-line summary of the arguments after the title. Sanitized by the adapter. */
  describeCall?(args: Readonly<Record<string, unknown>>): unknown;
  /** Replaces the whole call line, `describeCall` included. It owns sanitizing what it draws. */
  renderCall?: OmpToolDefinition["renderCall"];
  /** Short metadata after the badge, one entry per fact. Each entry is sanitized. */
  describeResult?(result: OmpResultView): readonly unknown[];
  /** Replaces the status line and the answer under it. It owns sanitizing what it draws. */
  renderResult?: OmpToolDefinition["renderResult"];
}

export interface OmpToolOptions {
  /** The host `Text` component, imported by the extension from the package root. */
  readonly Text: TextComponent;
  /** `"essential"` keeps every tool in OMP's top-level list. Left out, OMP hides them behind discovery. */
  readonly loadMode?: OmpToolDefinition["loadMode"];
  /** Status-line renderers by tool name. */
  readonly renderers?: Readonly<Record<string, OmpRenderers>>;
}

/** Answer lines in a collapsed row, as many as OMP's own MCP tools get. */
const COLLAPSED_LINES = 4;

/** OMP has no destructive tier, and `exec` stays for tools that really start processes. */
const APPROVAL: Record<ToolEffect, "read" | "write" | "exec"> = {
  read: "read",
  write: "write",
  destructive: "write",
  exec: "exec",
};

/**
 * Registers every tool on the OMP extension API.
 *
 * The schema reaches OMP through `pi.typebox.Type.Unsafe`: the host-injected
 * build validates the raw JSON Schema with its full validator and emits the
 * document verbatim, so `pattern` and `maxProperties` survive. A standalone
 * omptype schema would drop both.
 *
 * Every tool says `strict: false`. OMP's OpenAI strict mode makes each optional field required
 * and nullable, so the model fills them all with junk, and the core refuses even the `null`.
 *
 * @param pi - OMP extension API.
 * @param tools - Tools to register.
 * @param options - Host `Text`, optional load mode and renderers.
 * @throws {ToolDefinitionError} When two tools share a name.
 */
export function registerOmpTools(
  pi: ExtensionAPI,
  tools: readonly ToolDefinition[],
  options: OmpToolOptions,
): void {
  indexTools(tools);
  const { Type } = pi.typebox;
  const { Text } = options;

  for (const tool of tools) {
    const renderers = Object.hasOwn(options.renderers ?? {}, tool.name)
      ? options.renderers?.[tool.name]
      : undefined;

    pi.registerTool({
      name: tool.name,
      label: tool.title,
      description: tool.description,
      parameters: Type.Unsafe<Record<string, unknown>>(wireSchema(tool)),
      approval: APPROVAL[tool.effect],
      loadMode: options.loadMode,
      strict: false,
      async execute(_toolCallId, params, signal, onUpdate, ctx): Promise<AgentToolResult<unknown>> {
        const context = hostContext(signal, onUpdate, ctx);
        // Returned as is: OMP reads `isError` from the object (`explicitError`).
        return await invokeTool(tool, params, context).catch(throwWithCauses);
      },
      renderCall(args, renderOptions, theme): Component {
        if (renderers?.renderCall) return renderers.renderCall(args, renderOptions, theme);
        const summary = renderers?.describeCall ? sanitizeLine(renderers.describeCall(args)) : "";
        const title = theme.fg("accent", sanitizeLine(tool.title));
        return new Text(
          `${callIcon(renderOptions, theme)} ${title}${summary ? `: ${theme.fg("muted", summary)}` : ""}`,
          0,
          0,
        );
      },
      renderResult(result, renderOptions, theme, args): Component {
        if (renderers?.renderResult)
          return renderers.renderResult(result, renderOptions, theme, args);
        if (renderOptions.isPartial)
          return new Text(progressLine(tool, result, renderOptions, theme), 0, 0);
        const facts = result.isError ? [] : (renderers?.describeResult?.(result) ?? []);
        const status = `${statusLine(tool, result, theme)}${dimFacts(facts, theme)}`;
        const answer = answerLines(result, renderOptions.expanded, theme);
        return new Text(answer ? `${status}\n${answer}` : status, 0, 0);
      },
    });
  }
}

/**
 * Status line while the call runs: the spinner, the title and its last progress line.
 *
 * @param tool - Tool being called.
 * @param result - Partial result from `onUpdate`.
 * @param options - Render options from the host.
 * @param theme - Host theme.
 * @returns {string} The styled line.
 */
function progressLine(
  tool: ToolDefinition,
  result: Readonly<{ content: readonly Readonly<{ type: string; text?: string }>[] }>,
  options: ToolRenderResultOptions,
  theme: Theme,
): string {
  const message = sanitizeLine(
    result.content.findLast((block) => block.type === "text")?.text ?? "",
  );
  const title = theme.fg("accent", sanitizeLine(tool.title));
  return `${callIcon(options, theme)} ${title}${message ? ` ${theme.fg("dim", message)}` : ""}`;
}

/**
 * Status line of a finished call: the icon, the title and the approval badge.
 *
 * @param tool - Tool that was called.
 * @param result - Its result.
 * @param theme - Host theme.
 * @returns {string} The styled line, without the facts.
 */
function statusLine(tool: ToolDefinition, result: OmpResultView, theme: Theme): string {
  const icon = result.isError
    ? theme.styledSymbol("status.error", "error")
    : theme.styledSymbol("status.done", "success");
  const { bracketLeft, bracketRight } = theme.format;
  const badge = theme.fg("accent", `${bracketLeft}${APPROVAL[tool.effect]}${bracketRight}`);
  return `${icon} ${theme.fg("accent", sanitizeLine(tool.title))} ${badge}`;
}

/**
 * What the model got, shown to the person too. Collapsed, it counts what's cut.
 *
 * @param result - Text blocks of the result.
 * @param expanded - Whether the host shows the whole row.
 * @param theme - Host theme.
 * @returns {string} The sanitized lines, or nothing for a result without text.
 */
function answerLines(
  result: Readonly<{ content: readonly Readonly<{ type: string; text?: string }>[] }>,
  expanded: boolean,
  theme: Theme,
): string {
  const text = result.content
    .flatMap((block) => (block.type === "text" && block.text ? [block.text] : []))
    .join("\n");
  const lines = sanitizeText(text).trimEnd().split("\n");
  if (lines.join("") === "") return "";
  const shown = expanded ? lines : lines.slice(0, COLLAPSED_LINES);
  const body = shown.map((line) => theme.fg("toolOutput", line));
  const hidden = lines.length - shown.length;
  if (hidden > 0) body.push(theme.fg("dim", `… ${hidden} more lines`));
  return body.join("\n");
}

/**
 * The `describeResult` facts after the badge, sanitized and dimmed; empty ones drop out.
 *
 * @param facts - Facts as the renderer gave them.
 * @param theme - Host theme.
 * @returns {string} The facts with a leading space, or nothing.
 */
function dimFacts(facts: readonly unknown[], theme: Theme): string {
  const shown = facts.map(sanitizeLine).filter(Boolean);
  return shown.length > 0 ? ` ${theme.fg("dim", shown.join(theme.sep.dot))}` : "";
}

/**
 * Status icon for a call: pending, spinning or done.
 *
 * Drawn with the host theme on purpose: compiled OMP injects only the package
 * root, so importing `@oh-my-pi/pi-coding-agent/tui` would stop the extension.
 *
 * @param options - Render options from the host.
 * @param theme - Host theme.
 * @returns {string} The styled icon.
 */
function callIcon(options: ToolRenderResultOptions, theme: Theme): string {
  if (!options.isPartial) return theme.styledSymbol("status.done", "success");
  if (options.spinnerFrame === undefined) return theme.styledSymbol("status.pending", "muted");
  return (
    theme.spinnerFrames[options.spinnerFrame % theme.spinnerFrames.length] ??
    theme.styledSymbol("status.running", "accent")
  );
}
