/**
 * The `caused by:` lines under a thrown error, one copy for every host.
 *
 * MCP prints them under its first line. Pi, OMP and the AI SDK show only `message`, so there
 * the lines ride in the message itself.
 */

import { sanitizeLine, ToolInputError } from "./index.ts";

/** How far down `cause` an answer reads, and how long one of its lines may run. */
const CAUSE_DEPTH = 5;
const CAUSE_LENGTH = 300;

/**
 * One `caused by:` line per level under a thrown error, so a fallback's first failure survives.
 *
 * @param error - What the tool threw.
 * @returns {string[]} Up to {@link CAUSE_DEPTH} lines, credentials in URLs redacted.
 */
export function causeLines(error: unknown): string[] {
  const lines: string[] = [];
  const seen = new Set<unknown>([error]);
  let above = error instanceof Error ? error.message : String(error);
  let level = nextCause(error);
  for (let depth = 0; depth < CAUSE_DEPTH && level !== undefined && !seen.has(level); depth += 1) {
    seen.add(level);
    const text = causeText(level);
    if (text !== "" && !alreadySaid(above, text)) lines.push(`caused by: ${text}`);
    if (text !== "") above += `\n${text}`;
    level = nextCause(level);
  }
  return lines;
}

/**
 * Said once is enough, however deep the message quotes its chain.
 *
 * @param above - The message and every cause above.
 * @param text - This cause's line.
 * @returns {boolean} Whether {@link above} holds it anywhere, a cut line by its kept part.
 */
function alreadySaid(above: string, text: string): boolean {
  return above.includes(text.length > CAUSE_LENGTH ? text.slice(0, CAUSE_LENGTH) : text);
}

/**
 * The level under this one: its `cause`, or the first attempt of an `AggregateError` without one.
 *
 * @param error - One level of the chain.
 * @returns {unknown} The next level, `undefined` at the bottom.
 */
function nextCause(error: unknown): unknown {
  if (!(error instanceof Error)) return undefined;
  if (error.cause !== undefined) return error.cause;
  return error instanceof AggregateError ? (error.errors as unknown[])[0] : undefined;
}

/**
 * The line a cause gets: its message cut to {@link CAUSE_LENGTH} characters, credentials gone.
 * A package hides keys in the message it throws; nobody checked the raw error underneath.
 *
 * @param cause - One level of the chain.
 * @returns {string} Its text, empty when it has none worth a line.
 */
function causeText(cause: unknown): string {
  let text = "";
  if (cause instanceof Error) text = cause.message;
  else if (typeof cause === "string") text = cause;
  const safe = redactCredentials(boundedLine(text));
  return safe.length > CAUSE_LENGTH ? `${safe.slice(0, CAUSE_LENGTH).toWellFormed()}...` : safe;
}

/**
 * Cut before redacting, so a huge cause stays cheap; the word the cut splits goes whole.
 *
 * @param text - A cause's message.
 * @returns {string} One line of at most four cause lengths, ending in `...` when cut.
 */
function boundedLine(text: string): string {
  const line = sanitizeLine(text);
  const limit = CAUSE_LENGTH * 4;
  if (line.length <= limit) return line;
  const kept = line.slice(0, line.lastIndexOf(" ", limit) + 1);
  return `${kept}...`;
}

/** A URL's scheme, then its host up to where a path, query or userinfo would start. */
const URL_HOST =
  /\b((?:[a-z][a-z\d+.-]*:[/\\]+|(?:https?|wss?|ftp):))[^\s/\\?#]*?(?=[:,.;)\]"']*(?:\s|$)|[/\\?#@])/gi;
/** A field's name and separator, `"apiKey": ` or `x-api-key: ` or `token=`. */
const FIELD = /(["']?)([a-z][\w-]*)\1(\s*[=:]\s*)(?=\S)/gi;
const SECRET_NAME = /token|key|secret|pass|auth|sig|session|credential|cookie/i;
/** Node's `JSON.parse` quotes the start of its input, which may be a key file. */
const JSON_QUOTE = /"[^]*"(?:\.\.\.)? is not valid JSON/g;

/**
 * Overcautious on purpose: a cause nobody scrubbed costs a key, a lost path costs a guess.
 *
 * @param text - One line that may quote a URL, a field or a broken JSON input.
 * @returns {string} The line cut at the first URL path or secret field.
 */
function redactCredentials(text: string): string {
  return cutAtSecret(cutAtUrl(text.replaceAll(JSON_QUOTE, "input is not valid JSON")));
}

/**
 * Past a URL's host the line goes, past its scheme once an `@` follows: a password holds anything.
 *
 * @param text - One line.
 * @returns {string} The line up to the first URL with more than a host, then `/REDACTED`.
 */
function cutAtUrl(text: string): string {
  for (const url of text.matchAll(URL_HOST)) {
    const [whole, scheme = ""] = url;
    if (text.includes("@", url.index)) return `${text.slice(0, url.index)}${scheme}REDACTED`;
    const end = url.index + whole.length;
    if ("/\\?#".includes(text[end] ?? " ")) return `${text.slice(0, end)}/REDACTED`;
  }
  return text;
}

/**
 * Everything after the first secret field goes: a value's own end (quotes, `; sid=`) is no border.
 *
 * @param text - One line, URLs already cut.
 * @returns {string} The line up to that field's separator, then `REDACTED`.
 */
function cutAtSecret(text: string): string {
  for (const field of text.matchAll(FIELD)) {
    const [whole, quote = "", name = "", separator = ""] = field;
    if (isSecretField(quote, name, separator)) {
      return `${text.slice(0, field.index + whole.length)}REDACTED`;
    }
  }
  return text;
}

/**
 * A bare `name:` is prose (`Invalid key: must be hex`), so only JSON and header shapes count there.
 *
 * @param quote - Quote around the name, empty for none.
 * @param name - The field's name.
 * @param separator - `=` or `:` with the spaces around it.
 * @returns {boolean} Whether the value after it gets redacted.
 */
function isSecretField(quote: string, name: string, separator: string): boolean {
  if (!SECRET_NAME.test(name)) return false;
  if (!separator.includes(":") || quote !== "") return true;
  return name.includes("-") || /^(?:authorization|cookie)$/i.test(name);
}

/**
 * Rethrows for a host that shows only `message`: cause lines appended, the original as `cause`.
 *
 * @param error - What the tool threw.
 * @throws {unknown} The error itself for bad input or no cause lines, else a copy under its name.
 */
export function throwWithCauses(error: unknown): never {
  const lines = error instanceof ToolInputError ? [] : causeLines(error);
  if (lines.length === 0 || !(error instanceof Error)) throw error;
  const shown = new Error([error.message, ...lines].join("\n"), { cause: error });
  shown.name = error.name;
  throw shown;
}
