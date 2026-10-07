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

import { stripEscapes } from "./escapes.ts";

export { sanitizeText } from "./escapes.ts";

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
  /** A string property that takes every word left after `positional`, joined by single spaces. */
  readonly rest?: string;
  /** Short flags by property, `{ limit: "n" }` for `-n 5`. Only a whole word counts. */
  readonly short?: Readonly<Record<string, string>>;
  /** String properties that read stdin when given as `-`. */
  readonly stdin?: readonly string[];
  /** `false` takes `--json` away, for a command that writes its own bytes to stdout. */
  readonly json?: boolean;
}

/** How far a long call has come, for hosts that draw it. */
export interface ToolProgress {
  /** Work done so far. MCP skips an update where it doesn't grow. */
  readonly progress: number;
  /** All the work there is, when the tool knows it. */
  readonly total?: number;
}

/** An MCP icon, the SDK's own shape: a URL or `data:` URI a client can draw on its card. */
export interface Icon {
  readonly src: string;
  readonly mimeType?: string;
  /** `WxH` sizes such as `48x48`, or `any` for an SVG. */
  readonly sizes?: readonly string[];
  /** Background the icon is drawn for. */
  readonly theme?: "light" | "dark";
}

/** Per-call context the adapters hand to `execute`. */
export interface ToolCallContext {
  signal?: AbortSignal;
  /** Says the call is still at it. Absent where the host can't show it, so call `progress?.()`. */
  progress?: (message: string, amount?: ToolProgress) => void;
  /** Pi's or OMP's own `ctx`, the CLI's `CliHost`, nothing elsewhere. Narrow it yourself. */
  host?: unknown;
}

export interface ToolDefinition<Input extends TObject = TObject, Details = unknown> {
  /** Wire name, `<package>_<operation>`. */
  readonly name: string;
  /** Human label: MCP `title` and `annotations.title`, Pi and OMP `label`. */
  readonly title: string;
  /** Complete instruction for the model. MCP clients see nothing else. */
  readonly description: string;
  /** MCP `icons` in `tools/list`. Pi, OMP, the AI SDK and the CLI don't draw them. */
  readonly icons?: readonly Icon[];
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
 * line per failure: an undeclared key names itself with the keys its object
 * takes, at any depth, and an enum failure names the allowed values, so the
 * caller does not go back to the tool list and guess. Format from agntn/hashes
 * (#58). TypeBox stops at eight errors, so root keys are read off the arguments.
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

  const schema = wireSchema(tool);
  const rootKeys =
    args !== null && typeof args === "object" && !Array.isArray(args)
      ? Object.keys(args).filter((key) => !Object.hasOwn(tool.input.properties, key))
      : [];
  const unknown = rootKeys.map((key) => unknownKeyLine("", key, [schema]));
  const other: string[] = [];
  for (const error of Value.Errors(tool.input, args)) {
    if (error.keyword === "additionalProperties") continue;
    const refused = refusedKeyLines(schema, error.instancePath, error.schemaPath);
    if (refused === undefined)
      other.push(errorLine(error.instancePath, error.message, error.params));
    else unknown.push(...refused);
  }
  const lines = [...unknown, ...other];
  return { ok: false, lines: lines.length > 0 ? [...new Set(lines)] : ["Invalid arguments"] };
}

/**
 * @param at - JSON pointer of the failing value.
 * @param message - TypeBox's message.
 * @param params - TypeBox's parameters of the failure.
 * @returns {string} The line, with the allowed values when an enum failed.
 */
function errorLine(at: string, message: string, params: unknown): string {
  const allowed = isNode(params) ? params.allowedValues : undefined;
  const text = Array.isArray(allowed) ? `must be one of ${allowed.join(", ")}` : message;
  return `Invalid arguments at ${at || "/"}: ${text}`;
}

/**
 * A closed object refuses each extra key as `schema is false`, which names nothing on its own.
 *
 * @param root - Tool input schema.
 * @param at - JSON pointer of the failing value.
 * @param schemaPath - Schema path of the failure.
 * @returns {string[] | undefined} The line, none when another union branch takes the key, or
 *   `undefined` for any other failure.
 */
function refusedKeyLines(root: SchemaNode, at: string, schemaPath: string): string[] | undefined {
  const suffix = "/additionalProperties";
  if (!schemaPath.endsWith(suffix)) return undefined;
  const objectPath = schemaPath.slice(0, -suffix.length);
  const node = schemaAt(root, objectPath);
  if (node?.additionalProperties !== false) return undefined;
  const cut = at.lastIndexOf("/");
  const key = unescapeToken(at.slice(cut + 1));
  const alternatives = alternativesAt(root, objectPath);
  if (alternatives.some((alternative) => takesKey(alternative, key))) return [];
  return [unknownKeyLine(at.slice(0, cut), key, alternatives)];
}

/**
 * Each union branch fails on its own, so the same object in another branch may take the key.
 *
 * @param root - Tool input schema.
 * @param pointer - Schema path of a closed object.
 * @returns {SchemaNode[]} That object as every branch of every enclosing union has it.
 */
function alternativesAt(root: SchemaNode, pointer: string): SchemaNode[] {
  let nodes: unknown[] = [root];
  let previous = "";
  for (const token of pointer.split("/").slice(1)) {
    const key = unescapeToken(token);
    const everyBranch = previous === "anyOf" && /^\d+$/.test(key);
    nodes = nodes.flatMap((node): unknown[] => {
      if (everyBranch && Array.isArray(node)) return node;
      return isNode(node) && Object.hasOwn(node, key) ? [node[key]] : [];
    });
    previous = key;
  }
  return nodes.filter(isNode);
}

/**
 * @param token - One JSON pointer segment.
 * @returns {string} The property name it encodes.
 */
function unescapeToken(token: string): string {
  return token.replaceAll("~1", "/").replaceAll("~0", "~");
}

/**
 * @param node - Schema node.
 * @param key - Property name.
 * @returns {boolean} Whether an object of this schema accepts the key.
 */
function takesKey(node: SchemaNode, key: string): boolean {
  if (node.type !== "object") return false;
  if (node.additionalProperties !== false) return true;
  if (isNode(node.properties) && Object.hasOwn(node.properties, key)) return true;
  return patternsOf(node).some((pattern) => new RegExp(pattern, "u").test(key));
}

/**
 * @param node - Schema node.
 * @returns {string[]} Its `patternProperties` patterns.
 */
function patternsOf(node: SchemaNode): string[] {
  return Object.keys(isNode(node.patternProperties) ? node.patternProperties : {});
}

/**
 * @param at - JSON pointer of the object, empty at the root.
 * @param key - The undeclared key.
 * @param objects - Schema of that object, once per union branch it sits in.
 * @returns {string} The key with what the object takes, and the object's path when it is nested.
 */
function unknownKeyLine(at: string, key: string, objects: readonly SchemaNode[]): string {
  const lists = [
    ...new Set(
      objects
        .filter((object) => object.type === "object")
        .map((object) =>
          [
            ...Object.keys(isNode(object.properties) ? object.properties : {}),
            ...patternsOf(object).map((pattern) => `keys matching ${JSON.stringify(pattern)}`),
          ].join(", "),
        ),
    ),
  ];
  const takes = lists.length > 1 ? lists.map((list) => `{${list}}`).join(" or ") : lists[0];
  const where = at === "" ? "" : ` at ${at}`;
  const what = takes || "no properties";
  return `Invalid arguments${where}: unknown property ${JSON.stringify(key)}; takes ${what}`;
}

/**
 * @param root - Tool input schema.
 * @param pointer - Schema path from a validation error, such as `#/properties/point`.
 * @returns {SchemaNode | undefined} The subschema it points at.
 */
function schemaAt(root: SchemaNode, pointer: string): SchemaNode | undefined {
  let node: unknown = root;
  for (const token of pointer.split("/").slice(1)) {
    const key = unescapeToken(token);
    node = isNode(node) && Object.hasOwn(node, key) ? node[key] : undefined;
  }
  return isNode(node) ? node : undefined;
}

/**
 * Validates and runs a tool. Every adapter calls through here.
 *
 * Progress is best effort: a line after the call settles goes nowhere, and a host that throws on
 * one doesn't fail the call.
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
  const { progress } = context;
  if (!progress) return await tool.execute(checked.value, context);

  let settled = false;
  try {
    return await tool.execute(checked.value, {
      ...context,
      progress(message, amount) {
        if (settled) return;
        try {
          progress(sanitizeLine(message), amount);
        } catch {}
      },
    });
  } finally {
    settled = true;
  }
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
  return stripEscapes(String(value))
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
