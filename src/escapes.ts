/**
 * Terminal escape sequences, the pattern Node 26 uses in `stripVTControlCharacters`.
 * Kept here rather than imported from `node:util` so the core runs in a browser or a worker.
 */
export const ESCAPE_SEQUENCE =
  /* oxlint-disable-next-line no-control-regex */
  /(?:\u001B\][\s\S]*?(?:\u0007|\u001B\u005C|\u009C))|[\u001B\u009B][[\]()#;?]*(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]/g;

/** The same pattern without its OSC branch, for text no string terminator follows. */
const CONTROL_SEQUENCE =
  /* oxlint-disable-next-line no-control-regex */
  /[\u001B\u009B][[\]()#;?]*(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]/g;

/**
 * @param text - Text to search.
 * @param token - Terminator to find.
 * @returns {number} Index just past the last `token`, or 0 without one.
 */
function afterLast(text: string, token: string): number {
  const index = text.lastIndexOf(token);
  return index === -1 ? 0 : index + token.length;
}

/**
 * Node 26's `stripVTControlCharacters` to the letter, minus the quadratic walk: no OSC closes past
 * the last terminator, so that tail skips the branch that rescanned it from every `ESC ]`.
 *
 * @param text - Text to clean.
 * @returns {string} The text without escape sequences.
 */
export function stripEscapes(text: string): string {
  const end = Math.max(
    afterLast(text, "\u0007"),
    afterLast(text, "\u001B\\"),
    afterLast(text, "\u009C"),
  );
  return (
    text.slice(0, end).replaceAll(ESCAPE_SEQUENCE, "") +
    text.slice(end).replaceAll(CONTROL_SEQUENCE, "")
  );
}
