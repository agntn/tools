/**
 * A question for Pi and OMP: one dialog per field, through the host's own `ctx.ui`.
 *
 * Both hosts draw `select` and `input`, so a pick is a list, a toggle list for
 * several, and text or a number is a line of input. Escape anywhere closes the
 * form as `cancel`. A value the field refuses is named and asked for again.
 */

import type { TSchema } from "typebox";
import { Value } from "typebox/value";

import { problemText } from "./failures.ts";
import { sanitizeLine, type ToolAsk } from "./index.ts";
import { hostAsk, type HostQuestion } from "./questions.ts";

/** The dialogs of `ctx.ui` a question needs, the same in Pi and OMP. */
export interface DialogUi {
  readonly select: (
    title: string,
    options: readonly string[],
    dialog?: { readonly signal?: AbortSignal },
  ) => Promise<string | undefined>;
  readonly input: (
    title: string,
    placeholder?: string,
    dialog?: { readonly signal?: AbortSignal },
  ) => Promise<string | undefined>;
  readonly notify: (message: string, type?: "info" | "warning" | "error") => void;
}

type Field = Readonly<Record<string, unknown>>;

/** An optional field left out. */
const SKIP = Symbol("skip");
/** A dialog closed with Escape, which closes the whole form. */
const CLOSED = Symbol("closed");
/** What one prompt gives back: a value, `SKIP` or `CLOSED`. */
type Reply = unknown;

const SKIP_LABEL = "(skip)";
const DONE_LABEL = "Done";

/** One field of a question, with what its prompts need. */
interface Prompt {
  readonly ui: DialogUi;
  readonly title: string;
  readonly field: Field;
  readonly optional: boolean;
  readonly signal: AbortSignal | undefined;
}

/**
 * The `ask` for a host with dialogs, or nothing for one without.
 *
 * @param host - Pi's or OMP's `ctx` for the call.
 * @param signal - The call's abort signal, which also closes an open dialog.
 * @returns {ToolAsk | undefined} An `ask` when `ctx.hasUI` is set and the dialogs are there.
 */
export function dialogAsk(host: unknown, signal: AbortSignal | undefined): ToolAsk | undefined {
  const ui = dialogsOf(host);
  return ui ? hostAsk(async (question) => await fillForm(ui, question, signal)) : undefined;
}

/**
 * The host's dialogs, when it has a UI right now.
 *
 * @param host - Whatever the host handed over as `ctx`.
 * @returns {DialogUi | undefined} `ctx.ui`, if it can select, take input and notify.
 */
function dialogsOf(host: unknown): DialogUi | undefined {
  if (typeof host !== "object" || host === null) return undefined;
  const { hasUI, ui } = host as { readonly hasUI?: unknown; readonly ui?: unknown };
  if (hasUI !== true || typeof ui !== "object" || ui === null) return undefined;
  const { select, input, notify } = ui as Readonly<Record<string, unknown>>;
  const usable = [select, input, notify].every((dialog) => typeof dialog === "function");
  return usable ? (ui as DialogUi) : undefined;
}

/**
 * Asks for each field in order and hands back the reply MCP would.
 *
 * @param ui - Host dialogs.
 * @param question - The checked question.
 * @param signal - The call's abort signal.
 * @returns {Promise<unknown>} `accept` with the fields, or `cancel` once a dialog was closed.
 */
async function fillForm(
  ui: DialogUi,
  question: HostQuestion,
  signal: AbortSignal | undefined,
): Promise<unknown> {
  const keys = Object.keys(question.requested.properties);
  const required = new Set(question.requested.required);
  const content: Record<string, unknown> = {};
  for (const key of keys) {
    const field = question.requested.properties[key] ?? {};
    const title = sanitizeLine(
      keys.length === 1 ? question.message : `${question.message}: ${labelOf(key, field)}`,
    );
    const prompt = { ui, title, field, optional: !required.has(key), signal };
    const value = await askField(prompt, question.schema.properties[key], labelOf(key, field));
    if (value === CLOSED) return { action: "cancel" };
    if (value !== SKIP) content[key] = value;
  }
  return { action: "accept", content };
}

/**
 * Asks for one field until it gets a value the field takes.
 *
 * @param prompt - The field and its dialogs.
 * @param schema - Its TypeBox schema, which judges the value.
 * @param label - Its name, for the warning.
 * @returns {Promise<Reply>} The value, `SKIP` or `CLOSED`.
 */
async function askField(
  prompt: Prompt,
  schema: TSchema | undefined,
  label: string,
): Promise<Reply> {
  for (;;) {
    const value = await promptOnce(prompt);
    prompt.signal?.throwIfAborted();
    if (value === CLOSED || value === SKIP || !schema || Value.Check(schema, value)) return value;
    const [failure] = Value.Errors(schema, value);
    const problem = failure
      ? problemText(failure.message, failure.params)
      : "not a value this field takes";
    prompt.ui.notify(sanitizeLine(`${label}: ${problem}`), "warning");
  }
}

/**
 * One dialog for a field, chosen by its type.
 *
 * @param prompt - The field and its dialogs.
 * @returns {Promise<Reply>} What the user gave, unchecked.
 */
async function promptOnce(prompt: Prompt): Promise<Reply> {
  const { field } = prompt;
  if (field.type === "boolean") return await pick(prompt, [true, false], ["Yes", "No"]);
  if (field.type === "array") return await toggle(prompt);
  const [values, labels] = choicesOf(field);
  return values.length > 0 ? await pick(prompt, values, labels) : await typeIn(prompt);
}

/**
 * The values of a single pick and their lines: `enum`, or `oneOf` with a `title` per `const`.
 *
 * @param field - Field schema.
 * @returns {[unknown[], string[]]} Values and labels, both empty for a free field.
 */
function choicesOf(field: Field): [unknown[], string[]] {
  if (Array.isArray(field.enum)) return [field.enum, field.enum.map(String)];
  if (!Array.isArray(field.oneOf)) return [[], []];
  const branches = (field.oneOf as readonly unknown[]).filter(
    (branch): branch is Field => typeof branch === "object" && branch !== null && "const" in branch,
  );
  return [
    branches.map((branch) => branch.const),
    branches.map((branch) =>
      String(typeof branch.title === "string" ? branch.title : branch.const),
    ),
  ];
}

/**
 * A single pick from a list, with `(skip)` under it for an optional field.
 *
 * @param prompt - The field and its dialogs.
 * @param values - What each line stands for.
 * @param labels - What each line says.
 * @returns {Promise<Reply>} The picked value, `SKIP`, `CLOSED`, or an unknown line as is.
 */
async function pick(
  prompt: Prompt,
  values: readonly unknown[],
  labels: readonly string[],
): Promise<Reply> {
  const lines = labels.map(sanitizeLine);
  const options = prompt.optional ? [...lines, SKIP_LABEL] : lines;
  const chosen = await prompt.ui.select(prompt.title, options, signalOption(prompt));
  if (chosen === undefined) return CLOSED;
  const index = options.indexOf(chosen);
  if (index >= 0 && index < values.length) return values[index];
  return chosen === SKIP_LABEL && prompt.optional ? SKIP : chosen;
}

/**
 * Several picks: a list whose lines toggle until `Done`, starting from the field's default.
 *
 * @param prompt - The array field and its dialogs.
 * @returns {Promise<Reply>} The picked values in the enum's order, or `CLOSED`.
 */
async function toggle(prompt: Prompt): Promise<Reply> {
  const items = prompt.field.items as Field;
  const values = (items.enum as readonly string[]).map(String);
  const picked = new Set(Array.isArray(prompt.field.default) ? prompt.field.default : []);
  for (;;) {
    const lines = values.map(
      (value) => `${picked.has(value) ? "[x]" : "[ ]"} ${sanitizeLine(value)}`,
    );
    const chosen = await prompt.ui.select(
      prompt.title,
      [...lines, DONE_LABEL],
      signalOption(prompt),
    );
    if (chosen === undefined) return CLOSED;
    if (chosen === DONE_LABEL) return values.filter((value) => picked.has(value));
    const value = values[lines.indexOf(chosen)];
    if (value !== undefined && !picked.delete(value)) picked.add(value);
  }
}

/**
 * A line of input, read as a number for a numeric field. An empty line takes the default.
 *
 * @param prompt - The field and its dialogs.
 * @returns {Promise<Reply>} The typed value, `SKIP` or `CLOSED`.
 */
async function typeIn(prompt: Prompt): Promise<Reply> {
  const { field } = prompt;
  const text = await prompt.ui.input(prompt.title, hintOf(field), signalOption(prompt));
  if (text === undefined) return CLOSED;
  if (text === "" && field.default !== undefined) return field.default;
  if (text === "" && prompt.optional) return SKIP;
  return field.type === "number" || field.type === "integer" ? decimal(text) : text;
}

/**
 * The placeholder of a line of input: the field's `description`, else its default.
 *
 * @param field - Field schema.
 * @returns {string | undefined} One clean line, if the field has either.
 */
function hintOf(field: Field): string | undefined {
  const hint = typeof field.description === "string" ? field.description : field.default;
  return hint === undefined ? undefined : sanitizeLine(hint);
}

const DECIMAL = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;

/**
 * A number as written, so `0x10` or `1,5` fails the field instead of turning into another number.
 *
 * @param text - What the user typed.
 * @returns {Reply} The number, or the text for the field to refuse.
 */
function decimal(text: string): Reply {
  const trimmed = text.trim();
  return DECIMAL.test(trimmed) ? Number(trimmed) : text;
}

/**
 * The name a field shows: its `title`, else its key.
 *
 * @param key - Field name.
 * @param field - Its schema.
 * @returns {string} The label.
 */
function labelOf(key: string, field: Field): string {
  return typeof field.title === "string" ? field.title : key;
}

/**
 * Dialog options carrying the call's signal, when there is one.
 *
 * @param prompt - The field and its dialogs.
 * @returns {{ signal?: AbortSignal }} What every dialog takes last.
 */
function signalOption(prompt: Prompt): { readonly signal?: AbortSignal } {
  return prompt.signal ? { signal: prompt.signal } : {};
}
