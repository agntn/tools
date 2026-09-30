/**
 * One tool definition shared by every agent surface.
 *
 * A package declares each tool once with {@link defineTool}; the adapters in
 * `@agntn/tools/mcp`, `/pi`, `/omp` and `/ai` translate it into each host's
 * registration shape. The schema is plain TypeBox 1.x, which is plain JSON
 * Schema at runtime, so every host receives the same document.
 */

import type { Static, TObject, TSchema } from "typebox";

/**
 * TypeBox builders for tool schemas. Author schemas with this, not with a
 * bare `import { Type } from "typebox"`: OMP's extension loader rewrites the
 * bare `typebox` specifier, in the extension and every module it imports, to
 * its omptype facade, whose schemas are functions instead of JSON Schema.
 * Subpaths such as `typebox/type` are left alone.
 */
export * as Type from "typebox/type";
import { stripVTControlCharacters } from "node:util";

import { Value } from "typebox/value";

/** Content block understood by MCP, Pi and OMP alike. */
export type ToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

/** Text for the model plus details for the harness. */
export interface ToolResult<Details = unknown> {
  content: ToolContent[];
  details: Details;
  /** Set when the tool could not answer. Each adapter carries it to its host. */
  isError?: boolean;
}

/**
 * What a call does to the world, mapped to MCP annotations and OMP approval.
 *
 * - `read` changes nothing.
 * - `write` changes state that the next call can undo or overwrite.
 * - `destructive` deletes or overwrites what cannot be recovered.
 */
export type ToolEffect = "read" | "write" | "destructive";

/** Per-call context the adapters hand to `execute`. */
export interface ToolCallContext {
  signal?: AbortSignal;
}

export interface ToolDefinition<Input extends TObject = TObject, Details = unknown> {
  /** Wire name, `<package>_<operation>`. */
  readonly name: string;
  /** Human label: MCP `title`, Pi and OMP `label`. */
  readonly title: string;
  /** Complete instruction for the model. MCP clients see nothing else. */
  readonly description: string;
  /** Pi `promptSnippet`. */
  readonly snippet?: string;
  /** Pi `promptGuidelines`. Must not promise anything `description` lacks. */
  readonly guidelines?: readonly string[];
  readonly effect: ToolEffect;
  /** Repeating the call with the same input has no further effect. Defaults to `effect === "read"`. */
  readonly idempotent?: boolean;
  /** The call reaches outside the local machine. */
  readonly openWorld?: boolean;
  readonly input: Input;
  /**
   * Runs the tool on input that already passed {@link validateInput}.
   *
   * Method syntax on purpose: it keeps the parameter bivariant, so a list of
   * tools with different inputs is still a `readonly ToolDefinition[]`.
   */
  execute(
    input: Static<Input>,
    context: ToolCallContext,
  ): ToolResult<Details> | Promise<ToolResult<Details>>;
}

/** Thrown when a tool definition breaks a contract every surface relies on. */
export class ToolDefinitionError extends Error {
  override name = "ToolDefinitionError";
}

/** Thrown by {@link invokeTool} when the arguments fail the tool schema. */
export class ToolInputError extends Error {
  override name = "ToolInputError";
}

const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * Declares a tool and checks the schema rules every surface depends on.
 *
 * @param tool - Tool definition.
 * @returns {ToolDefinition<Input, Details>} The same definition, typed.
 */
export function defineTool<const Input extends TObject, Details>(
  tool: ToolDefinition<Input, Details>,
): ToolDefinition<Input, Details> {
  if (!TOOL_NAME.test(tool.name)) {
    throw new ToolDefinitionError(`Tool name ${JSON.stringify(tool.name)} must match ${TOOL_NAME}`);
  }
  if (typeof tool.input !== "object" || tool.input === null) {
    // A function here is an omptype schema: `Type` came from a bare `typebox`
    // import that OMP remapped. `Value.Check` accepts any value against it.
    throw new ToolDefinitionError(
      `${tool.name}: input must be a JSON Schema object; build it with Type from @agntn/tools, not from "typebox"`,
    );
  }
  assertSchema(tool.name, tool.input);
  return tool;
}

/**
 * Enforces two rules on the input schema.
 *
 * A non-empty object must be closed (`additionalProperties: false`), because a
 * misspelled key would otherwise be dropped without a signal: `read_only`
 * instead of `readOnly` ran `harnesses_run` with full tool access. An empty
 * object stays open, since models send placeholders like `{_: ""}` to it.
 *
 * A union of literals must be `Type.Enum`: TypeBox serializes the union as
 * `anyOf` const objects, which triples the wire size, and `Value.Errors`
 * reports it as `must be equal to constant` against the first literal only.
 */
function assertSchema(toolName: string, schema: TSchema, path = ""): void {
  const node = schema as Record<string, unknown>;
  const properties = node.properties as Record<string, TSchema> | undefined;

  if (node.type === "object" && properties && Object.keys(properties).length > 0) {
    if (node.additionalProperties !== false) {
      throw new ToolDefinitionError(
        `${toolName}: object at ${path || "/"} must be closed with additionalProperties: false`,
      );
    }
  }

  const anyOf = node.anyOf as Record<string, unknown>[] | undefined;
  if (anyOf && anyOf.length > 1 && anyOf.every((branch) => "const" in branch)) {
    throw new ToolDefinitionError(
      `${toolName}: union of literals at ${path || "/"} must use Type.Enum`,
    );
  }

  for (const [key, child] of Object.entries(properties ?? {}))
    assertSchema(toolName, child, `${path}/${key}`);
  if (node.items && typeof node.items === "object")
    assertSchema(toolName, node.items as TSchema, `${path}/items`);
  for (const branch of anyOf ?? []) assertSchema(toolName, branch as TSchema, path);
}

/**
 * The input schema as the plain JSON Schema object every host receives.
 *
 * TypeBox 1.x schemas are plain objects already; this only drops the static
 * type, which lacks the index signature host APIs declare.
 *
 * @param tool - Tool whose schema to emit.
 * @returns {Record<string, unknown>} JSON Schema document.
 */
export function wireSchema(tool: ToolDefinition): Record<string, unknown> {
  return Object.fromEntries(Object.entries(tool.input));
}

/**
 * Indexes tools by name.
 *
 * A `Map`, not a plain object: a lookup of `toString` in a `Record` finds
 * `Object.prototype.toString` and skips the unknown-tool branch.
 *
 * @param tools - Tools to index.
 * @returns {ReadonlyMap<string, ToolDefinition>} Tools by wire name.
 */
export function indexTools(tools: readonly ToolDefinition[]): ReadonlyMap<string, ToolDefinition> {
  const byName = new Map<string, ToolDefinition>();
  for (const tool of tools) {
    if (byName.has(tool.name)) throw new ToolDefinitionError(`Duplicate tool name ${tool.name}`);
    byName.set(tool.name, tool);
  }
  return byName;
}

export type InputCheck<Input extends TObject> =
  | { ok: true; value: Static<Input> }
  | { ok: false; message: string };

/**
 * Validates arguments against the tool schema, reporting every failure.
 *
 * Runs on every surface, not only MCP: a host may skip its own validation, and
 * OMP's omptype drops `pattern` from the schema it emits.
 *
 * @param tool - Tool whose schema applies.
 * @param args - Arguments as received from the host.
 * @returns {InputCheck<Input>} The typed value, or one message naming each failure.
 */
export function validateInput<Input extends TObject>(
  tool: ToolDefinition<Input, unknown>,
  args: unknown,
): InputCheck<Input> {
  if (Value.Check(tool.input, args)) return { ok: true, value: args };

  const accepted = Object.keys(tool.input.properties);
  const lines: string[] = [];
  const unknownKeys =
    args !== null && typeof args === "object" && !Array.isArray(args)
      ? Object.keys(args).filter((key) => !Object.hasOwn(tool.input.properties, key))
      : [];
  for (const key of unknownKeys) {
    lines.push(
      `at /: unknown property ${JSON.stringify(key)} (accepted: ${accepted.join(", ") || "none"})`,
    );
  }

  for (const error of Value.Errors(tool.input, args)) {
    // The closed-object failure is already reported above with the offending key.
    if (error.keyword === "additionalProperties") continue;
    const at = error.instancePath || "/";
    const params = error.params as { allowedValues?: unknown[] } | undefined;
    lines.push(
      error.keyword === "enum" && params?.allowedValues
        ? `at ${at}: must be one of ${params.allowedValues.map((value) => JSON.stringify(value)).join(", ")}`
        : `at ${at}: ${error.message}`,
    );
  }

  return {
    ok: false,
    message: `Invalid arguments ${[...new Set(lines)].join("; ") || "rejected by schema"}`,
  };
}

/**
 * Validates and runs a tool. Every adapter calls through here.
 *
 * @param tool - Tool to run.
 * @param args - Arguments as received from the host.
 * @param context - Per-call context.
 * @returns {Promise<ToolResult>} The executor's result, unchanged.
 * @throws {ToolInputError} When the arguments fail the schema.
 */
export async function invokeTool(
  tool: ToolDefinition,
  args: unknown,
  context: ToolCallContext = {},
): Promise<ToolResult> {
  const checked = validateInput(tool, args);
  if (!checked.ok) throw new ToolInputError(checked.message);
  return await tool.execute(checked.value, context);
}

const LINE_BREAKING = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/**
 * Makes a value safe for one line of terminal or protocol text.
 *
 * Removes escape sequences, then replaces every control, format, line and
 * paragraph separator character with a space: a raw newline, U+2028 or a bidi
 * override (U+202E, a `Cf`) in an echoed value forges a line that reads as the
 * tool's own output. `String()` first, since hostile JSON ignores declared types.
 *
 * @param value - Value to render.
 * @returns {string} Single-line text.
 */
export function sanitizeLine(value: unknown): string {
  return stripVTControlCharacters(String(value))
    .replaceAll(LINE_BREAKING, " ")
    .replaceAll(/ {2,}/g, " ")
    .trim();
}

/**
 * Text of a result, for hosts that carry failures as thrown errors.
 *
 * @param result - Tool result.
 * @returns {string} Text blocks joined by newlines.
 */
export function resultText(result: ToolResult): string {
  return result.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
}
