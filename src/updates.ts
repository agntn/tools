/** The call context Pi and OMP share: a signal and an `onUpdate` for partial results. */

import type { ToolCallContext, ToolContent } from "./index.ts";

/** A partial result as `onUpdate` takes it in Pi and OMP. */
export interface PartialResult {
  readonly content: ToolContent[];
  readonly details: Readonly<Record<string, never>>;
}

/**
 * Turns the host's signal and `onUpdate` into a context, one text block per progress line.
 *
 * @param signal - The call's abort signal, if the host passed one.
 * @param onUpdate - The host's partial result callback, if it passed one.
 * @returns {ToolCallContext} Context for `invokeTool`.
 */
export function hostContext(
  signal: AbortSignal | undefined,
  onUpdate: ((partial: PartialResult) => void) | undefined,
): ToolCallContext {
  return {
    ...(signal ? { signal } : {}),
    ...(onUpdate
      ? { progress: (text: string) => onUpdate({ content: [{ type: "text", text }], details: {} }) }
      : {}),
  };
}
