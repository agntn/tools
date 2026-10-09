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
import { problemText } from "./failures.ts";

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
  /** Words left after `positional`: joined by spaces into a string, one per item into an array. */
  readonly rest?: string;
  /** Positionals no dashed word may fill, such as ids. One there fails as an unknown option. */
  readonly plain?: readonly string[];
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

/** A small form for the user: one message over flat fields, the shape MCP elicitation takes. */
export interface ToolQuestion<Schema extends TObject = TObject> {
  /** What the user reads above the fields. Lines and tabs survive, escapes don't. */
  readonly message: string;
  /** Strings, numbers, booleans, `Type.Enum` picks and arrays of such an enum. Nothing nested. */
  readonly schema: Schema;
}

/** What came back: the checked fields on `accept`, nothing on a "no" or a closed form. */
export type ToolAnswer<Content> =
  | { readonly action: "accept"; readonly content: Content }
  | { readonly action: "decline" | "cancel" };

/** Puts a {@link ToolQuestion} in front of the user and waits for the {@link ToolAnswer}. */
export type ToolAsk = <Schema extends TObject>(
  question: ToolQuestion<Schema>,
) => Promise<ToolAnswer<Static<Schema>>>;

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
  /**
   * Asks the user and waits. Absent where nobody can answer, so check before calling.
   *
   * Over MCP the call starts over from the top for each answer, the earlier ones
   * replayed, so ask before the first effect and in the same order every time.
   */
  ask?: ToolAsk;
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
  /** MCP `_meta` in `tools/list`, such as `ui` or `openai/extensions`. No other surface reads it. */
  readonly meta?: Readonly<Record<string, unknown>>;
  /** Schema of `details`. MCP lists it as `outputSchema` and sends them as `structuredContent`. */
  readonly output?: TObject;
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

/** One schema failure, with its place kept apart so a surface can name it in its own words. */
export interface InputIssue {
  /** The line as {@link ToolInputError.lines} has it. */
  readonly line: string;
  /** JSON pointer of the failing value, empty for the arguments as a whole. */
  readonly at: string;
  /** What is wrong there, without the place. */
  readonly problem: string;
  /** Required properties the value at `at` lacks, when that is the failure. */
  readonly missing?: readonly string[];
}

/** Thrown by {@link invokeTool} when the arguments fail the tool schema. */
export class ToolInputError extends Error {
  override name = "ToolInputError";
  /** One validation failure per line. Only these line breaks are the core's own. */
  readonly lines: readonly string[];
  /** The schema failures behind the lines, empty when the lines come from elsewhere. */
  readonly issues: readonly InputIssue[];

  /**
   * @param lines - One validation failure per line.
   * @param issues - The schema failures behind them, if any.
   */
  constructor(lines: readonly string[], issues: readonly InputIssue[] = []) {
    super(lines.join("\n"));
    this.lines = lines;
    this.issues = issues;
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
  if (tool.output !== undefined && !isObjectSchema(tool.output)) {
    throw new ToolDefinitionError(
      `${tool.name}: output must be a JSON Schema object of type "object"; build it with Type.Object from @agntn/tools`,
    );
  }
  return tool;
}

type SchemaNode = Readonly<Record<string, unknown>>;

/**
 * MCP wants an object at the root of `outputSchema`, and a function there is an omptype schema.
 *
 * @param schema - Output schema from a definition.
 * @returns {boolean} Whether it is a plain JSON Schema object of type `object`.
 */
function isObjectSchema(schema: unknown): boolean {
  return isNode(schema) && schema.type === "object";
}

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
  | { ok: false; lines: readonly string[]; issues: readonly InputIssue[] };

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
  const unknown = rootKeys.map((key) => unknownKeyIssue("", key, [schema]));
  const other: InputIssue[] = [];
  for (const error of Value.Errors(tool.input, args)) {
    if (error.keyword === "additionalProperties") continue;
    const refused = refusedKeyIssues(schema, error.instancePath, error.schemaPath);
    if (refused === undefined)
      other.push(errorIssue(error.instancePath, error.message, error.params));
    else unknown.push(...refused);
  }
  const issues = [...new Map([...unknown, ...other].map((issue) => [issue.line, issue])).values()];
  if (issues.length === 0) return { ok: false, lines: ["Invalid arguments"], issues };
  return { ok: false, lines: issues.map((issue) => issue.line), issues };
}

/**
 * @param at - JSON pointer of the failing value.
 * @param message - TypeBox's message.
 * @param params - TypeBox's parameters of the failure.
 * @returns {InputIssue} The failure, with the allowed values when an enum failed.
 */
function errorIssue(at: string, message: string, params: unknown): InputIssue {
  const problem = problemText(message, params);
  const issue = { line: `Invalid arguments at ${at || "/"}: ${problem}`, at, problem };
  const missing = isNode(params) ? params.requiredProperties : undefined;
  return Array.isArray(missing) ? { ...issue, missing: missing.map(String) } : issue;
}

/**
 * A closed object refuses each extra key as `schema is false`, which names nothing on its own.
 *
 * @param root - Tool input schema.
 * @param at - JSON pointer of the failing value.
 * @param schemaPath - Schema path of the failure.
 * @returns {InputIssue[] | undefined} The failure, none when another union branch takes the key,
 *   or `undefined` for any other failure.
 */
function refusedKeyIssues(
  root: SchemaNode,
  at: string,
  schemaPath: string,
): InputIssue[] | undefined {
  const suffix = "/additionalProperties";
  if (!schemaPath.endsWith(suffix)) return undefined;
  const objectPath = schemaPath.slice(0, -suffix.length);
  const node = schemaAt(root, objectPath);
  if (node?.additionalProperties !== false) return undefined;
  const cut = at.lastIndexOf("/");
  const key = unescapeToken(at.slice(cut + 1));
  const alternatives = alternativesAt(root, objectPath);
  if (alternatives.some((alternative) => takesKey(alternative, key))) return [];
  return [unknownKeyIssue(at.slice(0, cut), key, alternatives)];
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
 * @returns {InputIssue} The key with what the object takes, and where the object sits when nested.
 */
function unknownKeyIssue(at: string, key: string, objects: readonly SchemaNode[]): InputIssue {
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
  const problem = `unknown property ${JSON.stringify(key)}; takes ${takes || "no properties"}`;
  return { line: `Invalid arguments${where}: ${problem}`, at, problem };
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
 * one doesn't fail the call. The call answers once every question it started has settled, and a
 * question after that point rejects: nobody waits for the answer.
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
  if (!checked.ok) throw new ToolInputError(checked.lines, checked.issues);
  const { progress, ask } = context;
  if (!progress && !ask) return await tool.execute(checked.value, context);

  let settled = false;
  const questions = ask ? closedAfter(tool, ask, () => settled) : undefined;
  try {
    const result = await tool.execute(checked.value, {
      ...context,
      ...(progress ? { progress: quietAfter(progress, () => settled) } : {}),
      ...(questions ? { ask: questions.ask } : {}),
    });
    await questions?.drained();
    return result;
  } finally {
    settled = true;
  }
}

/**
 * Progress that cleans each line, drops it once the call has settled and never throws.
 *
 * @param progress - The host's callback.
 * @param settled - Whether the call has answered.
 * @returns {NonNullable<ToolCallContext["progress"]>} The callback `execute` gets.
 */
function quietAfter(
  progress: NonNullable<ToolCallContext["progress"]>,
  settled: () => boolean,
): NonNullable<ToolCallContext["progress"]> {
  return (message, amount) => {
    if (settled()) return;
    try {
      progress(sanitizeLine(message), amount);
    } catch {}
  };
}

/** The questions of one call: the `ask` for `execute`, and a wait for every one it started. */
interface CallQuestions {
  readonly ask: ToolAsk;
  readonly drained: () => Promise<void>;
}

/**
 * Questions that reject once the call has settled instead of opening a form nobody reads.
 *
 * Each one stays open until it settles, and the call answers only after that,
 * so a question a tool forgot to `await` still reaches the person.
 *
 * @param tool - Tool being called.
 * @param ask - The host's question.
 * @param settled - Whether the call has answered.
 * @returns {CallQuestions} The question `execute` gets, and the wait for the open ones.
 */
function closedAfter(tool: ToolDefinition, ask: ToolAsk, settled: () => boolean): CallQuestions {
  const open = new Set<Promise<unknown>>();
  return {
    ask: async (question) => {
      if (settled()) throw new Error(`${tool.name} asked a question after its call had answered`);
      const answer = ask(question);
      open.add(answer);
      try {
        return await answer;
      } finally {
        open.delete(answer);
      }
    },
    drained: async () => {
      while (open.size > 0) await Promise.allSettled(open);
    },
  };
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
