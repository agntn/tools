/**
 * One tool definition shared by every agent surface.
 *
 * A package declares each tool once with {@link defineTool}; the adapters in
 * `@agntn/tools/mcp`, `/pi`, `/omp` and `/ai` translate it into each host's
 * registration shape. The schema is plain TypeBox 1.x, which is plain JSON
 * Schema at runtime, so every host receives the same document.
 */

import type { Static, TObject } from "typebox";

/**
 * TypeBox builders for tool schemas. Author schemas with this, not with a
 * bare `import { Type } from "typebox"`: OMP's extension loader rewrites the
 * bare `typebox` specifier, in the extension and every module it imports, to
 * its omptype facade, whose schemas are functions instead of JSON Schema.
 * Subpaths such as `typebox/type` are left alone.
 */
export * as Type from "typebox/type";

/**
 * Every schema type of the same bundled TypeBox build. Import them from here, not from `typebox`.
 * All of them, not a few: a package that exports a tool definition needs each type its schema
 * uses to be nameable in its declarations.
 */
export type * from "typebox";

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

/**
 * How a tool reads on the command line. Without hints the command is the tool
 * name without its package prefix, in kebab case, and every property is a flag.
 */
export interface ToolCliHints {
  /** Command name instead of the derived one. */
  readonly command?: string;
  readonly aliases?: readonly string[];
  /** Line in the command list. Defaults to the first sentence of `description`. */
  readonly description?: string;
  /** Properties taken in this order as positional arguments instead of flags. */
  readonly positional?: readonly string[];
  /** String properties that read stdin when given as `-`. */
  readonly stdin?: readonly string[];
}

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
  /** Command line shape for `@agntn/tools/cli`. No other surface reads it. */
  readonly cli?: ToolCliHints;
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
  /** One validation failure per line. Only these line breaks are the core's own. */
  readonly lines: readonly string[];

  /**
   * @param lines - One validation failure per line.
   */
  constructor(lines: readonly string[]) {
    super(lines.join("\n"));
    this.lines = lines;
  }
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
  assertSchema(tool.name, wireSchema(tool));
  return tool;
}

type SchemaNode = Readonly<Record<string, unknown>>;

/**
 * Enforces two rules on the input schema, at every depth.
 *
 * A non-empty object must be closed (`additionalProperties: false`), because a
 * misspelled key would otherwise be dropped without a signal: `read_only`
 * instead of `readOnly` ran `harnesses_run` with full tool access. An empty
 * object stays open, since models send placeholders like `{_: ""}` to it.
 *
 * A union of literals must be `Type.Enum`: TypeBox serializes the union as
 * `anyOf` const objects, which triples the wire size, and `Value.Errors`
 * reports it as `must be equal to constant` against the first literal only.
 *
 * @param toolName - Tool the schema belongs to, for the error.
 * @param node - Schema node to check.
 * @param path - JSON pointer of the node, empty at the root.
 */
function assertSchema(toolName: string, node: SchemaNode, path = ""): void {
  const at = path || "/";
  if (isOpenObject(node)) {
    throw new ToolDefinitionError(
      `${toolName}: object at ${at} must be closed with additionalProperties: false`,
    );
  }
  if (isLiteralUnion(node)) {
    throw new ToolDefinitionError(`${toolName}: union of literals at ${at} must use Type.Enum`);
  }
  for (const [child, childPath] of schemaChildren(node, path)) {
    assertSchema(toolName, child, childPath);
  }
}

/**
 * @param node - Schema node.
 * @returns {boolean} Whether the node is an object with properties that accepts other keys.
 */
function isOpenObject(node: SchemaNode): boolean {
  const properties = node.properties as SchemaNode | undefined;
  return (
    node.type === "object" &&
    properties !== undefined &&
    Object.keys(properties).length > 0 &&
    node.additionalProperties !== false
  );
}

/**
 * @param node - Schema node.
 * @returns {boolean} Whether the node is an `anyOf` of two or more constants.
 */
function isLiteralUnion(node: SchemaNode): boolean {
  const anyOf = node.anyOf as readonly SchemaNode[] | undefined;
  return anyOf !== undefined && anyOf.length > 1 && anyOf.every((branch) => "const" in branch);
}

/**
 * @param value - Any schema keyword value.
 * @returns {boolean} Whether it is a nested schema.
 */
function isNode(value: unknown): value is SchemaNode {
  return typeof value === "object" && value !== null;
}

/**
 * The subschemas a value of this node can reach: properties, record values,
 * array items and union branches.
 *
 * @param node - Schema node.
 * @param path - JSON pointer of the node.
 * @returns {Array<[SchemaNode, string]>} Each subschema with its path.
 */
function schemaChildren(node: SchemaNode, path: string): Array<[SchemaNode, string]> {
  const keyed = (keyword: string, childPath: (key: string) => string) =>
    Object.entries(isNode(node[keyword]) ? node[keyword] : {}).flatMap(
      ([key, child]): Array<[SchemaNode, string]> =>
        isNode(child) ? [[child, childPath(key)]] : [],
    );
  const branches = Array.isArray(node.anyOf) ? (node.anyOf as readonly unknown[]) : [];
  return [
    ...keyed("properties", (key) => `${path}/${key}`),
    ...keyed("patternProperties", () => `${path}/*`),
    ...(isNode(node.items) ? [[node.items, `${path}/items`] as [SchemaNode, string]] : []),
    ...branches.filter(isNode).map((branch): [SchemaNode, string] => [branch, path]),
  ];
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
  | { ok: false; lines: readonly string[] };

/**
 * Validates arguments against the tool schema, reporting every failure.
 *
 * Runs on every surface, not only MCP: a host may skip its own validation, and
 * OMP's omptype drops `pattern` from the schema it emits. The message has one
 * line per failure: an undeclared key names itself with the keys the tool
 * takes, and an enum failure names the allowed values, so the caller does not
 * go back to the tool list and guess. Format from agntn/hashes (#58).
 *
 * @param tool - Tool whose schema applies.
 * @param args - Arguments as received from the host.
 * @returns {InputCheck<Input>} The typed value, or the failures, one per line.
 */
export function validateInput<Input extends TObject>(
  tool: ToolDefinition<Input, unknown>,
  args: unknown,
): InputCheck<Input> {
  if (Value.Check(tool.input, args)) return { ok: true, value: args };

  const declared = Object.keys(tool.input.properties);
  const unknownKeys =
    args !== null && typeof args === "object" && !Array.isArray(args)
      ? Object.keys(args).filter((key) => !declared.includes(key))
      : [];
  // A closed schema reports each undeclared key again, as `schema is false` at its path.
  const reported = new Set(
    unknownKeys.map((key) => `/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`),
  );
  const lines = [
    ...unknownKeys.map(
      (key) =>
        `Invalid arguments: unknown property ${JSON.stringify(key)}; takes ${declared.join(", ")}`,
    ),
    ...Value.Errors(tool.input, args)
      .filter(
        (error) => error.keyword !== "additionalProperties" && !reported.has(error.instancePath),
      )
      .map((error) => {
        const allowed =
          error.keyword === "enum"
            ? (error.params as { allowedValues?: unknown }).allowedValues
            : undefined;
        const message = Array.isArray(allowed)
          ? `must be one of ${allowed.join(", ")}`
          : error.message;
        return `Invalid arguments at ${error.instancePath || "/"}: ${message}`;
      }),
  ];
  return { ok: false, lines: lines.length > 0 ? [...new Set(lines)] : ["Invalid arguments"] };
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
  if (!checked.ok) throw new ToolInputError(checked.lines);
  return await tool.execute(checked.value, context);
}

const LINE_BREAKING = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/**
 * Terminal escape sequences, the pattern Node 26 uses in `stripVTControlCharacters`.
 * Kept here rather than imported from `node:util` so the core runs in a browser or a worker.
 */
const ESCAPE_SEQUENCE =
  /* oxlint-disable-next-line no-control-regex */
  /(?:\u001B\][\s\S]*?(?:\u0007|\u001B\u005C|\u009C))|[\u001B\u009B][[\]()#;?]*(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]/g;

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
  return String(value)
    .replaceAll(ESCAPE_SEQUENCE, "")
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
