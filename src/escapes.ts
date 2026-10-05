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

/** C0 and C1 controls but tab and line feed, and the bidi marks, embeddings, overrides and isolates. */
const FORGING =
  /* oxlint-disable-next-line no-control-regex */
  /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u206F]/g;

/**
 * Makes multi-line tool text safe for a terminal. Unlike {@link sanitizeLine}
 * it keeps the layout: line feeds, tabs and the joiners of emoji and scripts
 * (ZWJ, ZWNJ) stay, CR and CRLF become a line feed, and the Unicode line and
 * paragraph separators become a space so words do not run together.
 *
 * @param text - Tool text.
 * @returns {string} The text without escape sequences or other control characters.
 */
export function sanitizeText(text: string): string {
  return stripEscapes(text.replaceAll(/\r\n?/g, "\n"))
    .replaceAll(FORGING, "")
    .replaceAll(/[\u2028\u2029]/g, " ");
}
