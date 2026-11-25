/**
 * Questions for the user, shared by every adapter that can ask one.
 *
 * MCP elicitation takes only a flat form, so the schema is checked here and
 * every host refuses the same shapes. Each answer is checked against the
 * schema that asked for it: a client or a dialog may hand back anything.
 */

import type { Static, TObject } from "typebox";
import { Value } from "typebox/value";

import { sanitizeText } from "./escapes.ts";
import {
  sanitizeLine,
  ToolDefinitionError,
  type ToolAnswer,
  type ToolAsk,
  type ToolQuestion,
} from "./index.ts";

/** The form as MCP's `requestedSchema` carries it: one object of primitive fields. */
export interface RequestedSchema {
  readonly type: "object";
  readonly properties: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly required?: readonly string[];
}

/** A question as a host gets it: the message cleaned, the fields for MCP and as TypeBox. */
export interface HostQuestion {
  readonly message: string;
  /** The fields for MCP, built when a host asks: only ChatGPT can show some. */
  readonly requested: () => RequestedSchema;
  /** The fields as ChatGPT reads them, resource pickers and all. */
  readonly openai: RequestedSchema;
  readonly schema: TObject;
}

type Node = Readonly<Record<string, unknown>>;

const PRIMITIVES = new Set(["string", "number", "integer", "boolean"]);

/** What a form's root may say. A rule like `minProperties` reaches no client and fails late. */
const ROOT_KEYS = new Set([
  "type",
  "properties",
  "required",
  "additionalProperties",
  "title",
  "description",
]);

/**
 * The schema of a question as MCP elicitation sends it.
 *
 * `Type.Enum` leaves out `type`, which elicitation wants on every field, so
 * a string enum gets `type: "string"` here, in an array's items too.
 *
 * @param question - The question.
 * @returns {RequestedSchema} `type`, `properties` and `required`, nothing else.
 * @throws {ToolDefinitionError} When the root isn't an object or a field isn't flat.
 */
export function requestedSchema(question: ToolQuestion): RequestedSchema {
  return formOf(question, false);
}

/**
 * The same form for ChatGPT, whose resource picker keeps its `x-openai-input`.
 *
 * @param question - The question.
 * @returns {RequestedSchema} The form ChatGPT draws.
 * @throws {ToolDefinitionError} Where {@link requestedSchema} throws.
 */
export function openaiSchema(question: ToolQuestion): RequestedSchema {
  return formOf(question, true);
}

/**
 * One form of a question, for ChatGPT or for everyone else.
 *
 * @param question - The question.
 * @param openai - Whether ChatGPT reads it.
 * @returns {RequestedSchema} The checked form.
 * @throws {ToolDefinitionError} When the root isn't an object or a field isn't flat.
 */
function formOf(question: ToolQuestion, openai: boolean): RequestedSchema {
  const root: unknown = JSON.parse(JSON.stringify(question.schema));
  if (!isRecord(root) || root.type !== "object" || !isRecord(root.properties)) {
    throw new ToolDefinitionError("A question needs a Type.Object of fields");
  }
  const extra = Object.keys(root).find((key) => !ROOT_KEYS.has(key));
  if (extra !== undefined) {
    throw new ToolDefinitionError(
      `A question can't carry ${JSON.stringify(extra)} on its Type.Object: an MCP form has no place for it`,
    );
  }
  const properties = Object.fromEntries(
    Object.entries(root.properties).map(([key, field]) => [key, flatField(key, field, openai)]),
  );
  const required = Array.isArray(root.required) ? root.required.map(String) : [];
  return { type: "object", properties, ...(required.length > 0 ? { required } : {}) };
}

/**
 * One field as elicitation takes it.
 *
 * @param key - Field name, for the error.
 * @param field - Its schema, as JSON.
 * @param openai - Whether ChatGPT reads it.
 * @returns {Node} The field, with `type` filled in for a string enum.
 * @throws {ToolDefinitionError} When the field is an object, a union or another nested shape.
 */
function flatField(key: string, field: unknown, openai: boolean): Node {
  if (isRecord(field)) {
    if (isStringEnum(field)) return cleanLabels({ type: "string", ...field });
    if (typeof field.type === "string" && PRIMITIVES.has(field.type)) return cleanLabels(field);
    const several = field.type === "array" ? severalField(key, field, openai) : undefined;
    if (several) return several;
  }
  throw new ToolDefinitionError(
    `Question field ${JSON.stringify(key)} must be a string, number, integer, boolean, Type.Enum of strings, an array of one or a resource pick`,
  );
}

/**
 * An array field: several picks from an enum, or several resources.
 *
 * @param key - Field name, for the error.
 * @param field - The array's schema.
 * @param openai - Whether ChatGPT reads it.
 * @returns {Node | undefined} The field, or nothing for an array a form can't show.
 * @throws {ToolDefinitionError} When a resource pick has no options for other clients.
 */
function severalField(key: string, field: Node, openai: boolean): Node | undefined {
  const { items, "x-openai-input": input } = field;
  if (!isRecord(items)) return undefined;
  if (isStringEnum(items)) return cleanLabels({ ...field, items: { type: "string", ...items } });
  const options = items.type === "string" ? resourceOptions(input) : undefined;
  if (!options) return undefined;
  if (openai) {
    return cleanLabels({ ...field, "x-openai-input": { ...(input as Node), options } });
  }
  if (options.length === 0) {
    throw new ToolDefinitionError(
      `Question field ${JSON.stringify(key)} needs options: only ChatGPT can pick a resource without one`,
    );
  }
  const anyOf = options.map((option) => ({ const: option.uri, title: resourceTitle(option) }));
  return cleanLabels({
    ...withoutPicker(field),
    ...implicitDefault(input, options),
    items: { anyOf },
  });
}

/**
 * The picks an implicit picker starts with: every option, as ChatGPT shows it.
 *
 * @param input - The field's `x-openai-input`.
 * @param options - Its resources.
 * @returns {Node} A `default` of every URI, or nothing for an explicit picker.
 */
function implicitDefault(input: unknown, options: readonly ResourceOption[]): Node {
  const implicit = isRecord(input) && input.selection === "implicit";
  return implicit ? { default: options.map((option) => option.uri) } : {};
}

/** One resource ChatGPT offers in a picker. */
interface ResourceOption extends Node {
  readonly uri: string;
}

/**
 * The options of an `x-openai-input` resource picker, their labels cleaned.
 *
 * @param input - The field's `x-openai-input`.
 * @returns {ResourceOption[] | undefined} Options with a `uri` each, or nothing for another input.
 */
function resourceOptions(input: unknown): ResourceOption[] | undefined {
  if (!isRecord(input) || input.type !== "resource" || !Array.isArray(input.options)) {
    return undefined;
  }
  const options = (input.options as readonly unknown[]).map(cleanBranch);
  return options.every(isResource) ? options : undefined;
}

/**
 * Whether a picker option is a resource with a URI.
 *
 * @param option - One entry of `options`.
 * @returns {boolean} Whether it has a string `uri`.
 */
function isResource(option: unknown): option is ResourceOption {
  return isRecord(option) && typeof option.uri === "string";
}

/**
 * The line a resource gets where there's no picker: its `title`, `name` or URI.
 *
 * @param option - The resource.
 * @returns {string} The label.
 */
function resourceTitle(option: ResourceOption): string {
  const label = [option.title, option.name].find((value) => typeof value === "string");
  return typeof label === "string" ? label : option.uri;
}

/**
 * A field without ChatGPT's picker, which no other client reads.
 *
 * @param field - The array's schema.
 * @returns {Node} Every other key.
 */
function withoutPicker(field: Node): Node {
  return Object.fromEntries(Object.entries(field).filter(([key]) => key !== "x-openai-input"));
}

/**
 * A field whose `title`, `description`, item and choice titles are each one clean line.
 *
 * @param field - Field schema.
 * @returns {Node} The field with clean labels. Values stay, since they come back.
 */
function cleanLabels(field: Node): Node {
  const labels = Object.fromEntries(
    (["title", "description"] as const)
      .filter((key) => typeof field[key] === "string")
      .map((key) => [key, sanitizeLine(field[key])]),
  );
  const branches = Object.fromEntries(
    (["oneOf", "anyOf"] as const)
      .filter((key) => Array.isArray(field[key]))
      .map((key) => [key, (field[key] as readonly unknown[]).map(cleanBranch)]),
  );
  const items = isRecord(field.items) ? { items: cleanLabels(field.items) } : {};
  return { ...field, ...labels, ...branches, ...items };
}

/**
 * One titled choice of a pick, cleaned like a field.
 *
 * @param branch - A `oneOf` or `anyOf` entry.
 * @returns {unknown} The entry with clean labels, or as it was when it isn't an object.
 */
function cleanBranch(branch: unknown): unknown {
  return isRecord(branch) ? cleanLabels(branch) : branch;
}

/**
 * Whether a schema is an enum of strings, typed as one or not typed at all.
 *
 * @param node - Schema to look at.
 * @returns {boolean} Whether elicitation can show it as a single pick.
 */
function isStringEnum(node: Node): boolean {
  return (
    Array.isArray(node.enum) &&
    node.enum.length > 0 &&
    node.enum.every((value) => typeof value === "string") &&
    (node.type === undefined || node.type === "string")
  );
}

/**
 * Reads a reply against the question's schema, keeping only the fields it asked for.
 *
 * @param question - The question it answers.
 * @param reply - Whatever came back from the client or the dialog.
 * @returns {ToolAnswer<unknown> | undefined} The answer, or nothing when it doesn't fit.
 */
export function readAnswer(
  question: ToolQuestion,
  reply: unknown,
): ToolAnswer<unknown> | undefined {
  const { schema } = question;
  if (!isRecord(reply)) return undefined;
  if (reply.action === "decline" || reply.action === "cancel") return { action: reply.action };
  if (reply.action !== "accept") return undefined;
  const given = isRecord(reply.content) ? reply.content : {};
  const content = Object.fromEntries(
    Object.keys(schema.properties)
      .filter((key) => Object.hasOwn(given, key))
      .map((key) => [key, given[key]]),
  );
  return Value.Check(schema, content) ? { action: "accept", content } : undefined;
}

/**
 * Builds the `ask` an adapter hands to `execute` from the host's own way of asking.
 *
 * The reply passes `Value.Check` in `readAnswer`, which is what makes it a `Static<Schema>`.
 *
 * @param ask - Shows one question and resolves with the raw reply.
 * @returns {ToolAsk} Checks the form first, cleans the message and checks the reply.
 * @throws {ToolDefinitionError} From the returned function, on a form elicitation can't show.
 */
export function hostAsk(ask: (question: HostQuestion) => Promise<unknown>): ToolAsk {
  return async <Schema extends TObject, Content extends Static<Schema> = Static<Schema>>({
    message,
    schema,
  }: {
    readonly message: string;
    readonly schema: Schema;
  }): Promise<ToolAnswer<Content>> => {
    const question = { message: sanitizeText(message), schema };
    const openai = openaiSchema(question);
    const reply = await ask({ ...question, openai, requested: () => requestedSchema(question) });
    const answer = readAnswer(question, reply);
    if (!answer) throw new Error("The answer doesn't fit the question");
    return answer as ToolAnswer<Content>;
  };
}

/**
 * Whether a value is a plain object, the only shape a schema or a reply can have.
 *
 * @param value - Value to look at.
 * @returns {boolean} Whether it is a non-array object.
 */
function isRecord(value: unknown): value is Node {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
