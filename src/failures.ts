/** How a schema failure reads, shared by the core's validation lines and the Pi and OMP dialogs. */

/**
 * The problem of one TypeBox failure, with the allowed values in place of its words for an enum.
 *
 * @param message - TypeBox's message.
 * @param params - TypeBox's parameters of the failure.
 * @returns {string} What is wrong, without the place.
 */
export function problemText(message: string, params: unknown): string {
  const allowed =
    typeof params === "object" && params !== null
      ? (params as { readonly allowedValues?: unknown }).allowedValues
      : undefined;
  return Array.isArray(allowed) ? `must be one of ${allowed.join(", ")}` : message;
}
