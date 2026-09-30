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

import {
  invokeTool,
  sanitizeLine,
  wireSchema,
  type ToolDefinition,
  type ToolEffect,
} from "./index.ts";

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
  /** Short metadata after the badge, one entry per fact. Each entry is sanitized. */
  describeResult?(result: OmpResultView): readonly unknown[];
  /**
   * Replaces the result status line with the package's own component, such as
   * a bounded preview of long output. It owns sanitizing what it draws.
   */
  renderResult?: OmpToolDefinition["renderResult"];
}

export interface OmpToolOptions {
  /** The host `Text` component, imported by the extension from the package root. */
  readonly Text: TextComponent;
  /** Status-line renderers by tool name. */
  readonly renderers?: Readonly<Record<string, OmpRenderers>>;
}

const APPROVAL: Record<ToolEffect, "read" | "write"> = {
  read: "read",
  write: "write",
  // OMP has no destructive tier; `exec` means running commands.
  destructive: "write",
};

/**
 * Registers every tool on the OMP extension API.
 *
 * The schema reaches OMP through `pi.typebox.Type.Unsafe`: the host-injected
 * build validates the raw JSON Schema with its full validator and emits the
 * document verbatim, so `pattern` and `maxProperties` survive. A standalone
 * omptype schema would drop both.
 *
 * @param pi - OMP extension API.
 * @param tools - Tools to register.
 * @param options - Host `Text` and optional renderers.
 */
export function registerOmpTools(
  pi: ExtensionAPI,
  tools: readonly ToolDefinition[],
  options: OmpToolOptions,
): void {
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
      async execute(_toolCallId, params, signal): Promise<AgentToolResult<unknown>> {
        // Returned as is: OMP reads `isError` from the object (`explicitError`).
        return await invokeTool(tool, params, signal ? { signal } : {});
      },
      renderCall(args, renderOptions, theme): Component {
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
        const icon = result.isError
          ? theme.styledSymbol("status.error", "error")
          : theme.styledSymbol("status.done", "success");
        const { bracketLeft, bracketRight } = theme.format;
        const badge = theme.fg("accent", `${bracketLeft}${APPROVAL[tool.effect]}${bracketRight}`);
        const facts = result.isError
          ? []
          : (renderers?.describeResult?.(result).map(sanitizeLine).filter(Boolean) ?? []);
        const meta = facts.length > 0 ? ` ${theme.fg("dim", facts.join(theme.sep.dot))}` : "";
        return new Text(
          `${icon} ${theme.fg("accent", sanitizeLine(tool.title))} ${badge}${meta}`,
          0,
          0,
        );
      },
    });
  }
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
