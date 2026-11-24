/**
 * Loads a module once and hands it out, but never to a call cancelled while it loaded.
 *
 * @param load - The `import()`, run again after a failure.
 * @returns {(signal?: AbortSignal) => Promise<T>} The loader `execute` awaits.
 */
export function lazy<T>(load: () => Promise<T>): (signal?: AbortSignal) => Promise<T> {
  let pending: Promise<T> | undefined;
  return async (signal) => {
    pending ??= load().catch((error: unknown) => {
      pending = undefined;
      throw error;
    });
    const value = await pending;
    signal?.throwIfAborted();
    return value;
  };
}
