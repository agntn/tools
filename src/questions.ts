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
  readonly requested: RequestedSchema;
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
    Object.entries(root.properties).map(([key, field]) => [key, flatField(key, field)]),
  );
  const required = Array.isArray(root.required) ? root.required.map(String) : [];
  return { type: "object", properties, ...(required.length > 0 ? { required } : {}) };
}

/**
 * One field as elicitation takes it.
 *
 * @param key - Field name, for the error.
 * @param field - Its schema, as JSON.
 * @returns {Node} The field, with `type` filled in for a string enum.
 * @throws {ToolDefinitionError} When the field is an object, a union or another nested shape.
 */
function flatField(key: string, field: unknown): Node {
  if (isRecord(field)) {
    if (isStringEnum(field)) return cleanLabels({ type: "string", ...field });
    if (typeof field.type === "string" && PRIMITIVES.has(field.type)) return cleanLabels(field);
    if (field.type === "array" && isRecord(field.items) && isStringEnum(field.items)) {
      return cleanLabels({ ...field, items: { type: "string", ...field.items } });
    }
  }
  throw new ToolDefinitionError(
    `Question field ${JSON.stringify(key)} must be a string, number, integer, boolean, Type.Enum of strings or an array of one`,
  );
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
  return async <Schema extends TObject>({
    message,
    schema,
  }: {
    readonly message: string;
    readonly schema: Schema;
  }): Promise<ToolAnswer<Static<Schema>>> => {
    const question = { message: sanitizeText(message), schema };
    const reply = await ask({ ...question, requested: requestedSchema(question) });
    const answer = readAnswer(question, reply);
    if (!answer) throw new Error("The answer doesn't fit the question");
    return answer as ToolAnswer<Static<Schema>>;
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
