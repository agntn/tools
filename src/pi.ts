/**
 * Pi adapter: registers {@link ToolDefinition}s on a Pi `ExtensionAPI`.
 *
 * Only types come from `@earendil-works/pi-coding-agent`; nothing is imported
 * from the host at runtime.
 */

import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { invokeTool, resultText, type ToolDefinition } from "./index.ts";

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
}

/**
 * Registers every tool on the Pi extension API.
 *
 * @param pi - Pi extension API.
 * @param tools - Tools to register.
 * @param options - Failure policy.
 */
export function registerPiTools(
  pi: ExtensionAPI,
  tools: readonly ToolDefinition[],
  options: PiToolOptions = {},
): void {
  const failures = options.failures ?? "throw";

  for (const tool of tools) {
    pi.registerTool({
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
