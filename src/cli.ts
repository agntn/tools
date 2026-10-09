/**
 * CLI adapter: one command per {@link ToolDefinition}, plus the package's own
 * commands and an optional stdio MCP server, with no CLI library underneath.
 *
 * A tool's properties become flags, its {@link ToolCliHints} pick positionals,
 * short flags and stdin, and every call goes through {@link invokeTool}, so the
 * command line validates and fails like every other surface. A package
 * command is a tool definition too, one that only the CLI gets.
 */

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { Value } from "typebox/value";

import { sanitizeText } from "./escapes.ts";
import {
  indexTools,
  invokeTool,
  resultText,
  sanitizeLine,
  ToolDefinitionError,
  ToolInputError,
  validateInput,
  type InputIssue,
  type ToolCallContext,
  type ToolDefinition,
  type ToolProgress,
} from "./index.ts";
import type { McpServerInfo } from "./mcp-answers.ts";

export interface CliOptions {
  /** Executable name, also the MCP server name. */
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly tools: readonly ToolDefinition[];
  /**
   * The package's own commands, as tool definitions that only the CLI gets:
   * no MCP, Pi, OMP or AI SDK host sees them. One whose command name matches
   * a generated command, `mcp` included, takes its place. Bytes are the
   * command's own business: it reads `-` from stdin itself in `execute`, and
   * writes to stdout itself, answering with no content and `cli.json: false`.
   * A command that prints rows as they land reads `--json` off its {@link CliHost},
   * and leaves `progress` alone: on a terminal its line would sit in front of the rows.
   */
  readonly commands?: readonly ToolDefinition[];
  /** Command for an empty command line. */
  readonly default?: string;
  /** Command for a first word that names no command: `hashes sha256 x` runs `hashes hash sha256 x`. */
  readonly fallback?: string;
  /** Adds `mcp` over stdio, named by the CLI on `true` or by the server info it's handed. */
  readonly mcp?: boolean | McpServerInfo;
  /**
   * Errors the package throws on purpose. They print as one line with exit
   * code 1; any other error keeps its stack trace.
   */
  readonly expected?: (error: unknown) => boolean;
}

/** What a CLI command finds in `host`: narrow to it and look at `json` before writing a byte. */
export interface CliHost {
  readonly cli: true;
  /** `--json` was given, so the details are the answer and stdout stays theirs. */
  readonly json: boolean;
}

/** A flag `--<flag>` can spell: not empty, no `=`, no space or control, not starting with `-`. */
const FLAG_WORD = /^[a-z0-9][a-z0-9.-]*$/;

/** Flags every tool command answers itself. */
const RESERVED_FLAGS = new Set(["help", "version", "json"]);

/** Kinds whose value is the text itself: `enum` is string values only. */
const TEXT_KINDS = new Set<FieldKind>(["string", "enum"]);

/** A short flag: one letter, so a negative number never reads as one. */
const SHORT_FLAG = /^[a-z]$/i;

type FieldKind = "string" | "number" | "boolean" | "enum" | "json";

interface Field {
  readonly key: string;
  readonly schema: SchemaNode;
  readonly required: boolean;
  readonly flag: string;
  readonly kind: FieldKind;
  readonly positional: boolean;
  /** A dashed word that lands here fails as an unknown option instead. */
  readonly plain: boolean;
  /** Takes the words the other positionals leave, so it's always the last one. */
  readonly rest: boolean;
  /** Items of a `rest` array, where each word stays one item instead of joining the others. */
  readonly restItems: SchemaNode | undefined;
  readonly short: string | undefined;
  readonly stdin: boolean;
}

type SchemaNode = Readonly<Record<string, unknown>>;

const TYPE_KINDS = new Map<unknown, FieldKind>([
  ["boolean", "boolean"],
  ["integer", "number"],
  ["number", "number"],
  ["object", "json"],
  ["array", "json"],
]);

/**
 * @param key - Property name, `camelCase` or `snake_case`.
 * @returns {string} The flag, in kebab case.
 */
function flagName(key: string): string {
  return key
    .replaceAll(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replaceAll("_", "-")
    .toLowerCase();
}

/**
 * @param tool - Tool to name.
 * @returns {string} The hinted command, or the tool name without its package prefix, in kebab case.
 */
export function commandName(tool: ToolDefinition): string {
  if (tool.cli?.command !== undefined) return commandWord(tool.name, tool.cli.command);
  const separator = tool.name.indexOf("_");
  const derived = separator === -1 ? tool.name : tool.name.slice(separator + 1);
  // `pkg__h` would derive `-h` and `pkg_` nothing; neither can be dispatched.
  return commandWord(tool.name, derived.replaceAll("_", "-"));
}

/** A command word the CLI can dispatch to: not empty, not an option, nothing that forges a line. */
const COMMAND_WORD = /^[a-z0-9_][a-z0-9_.:-]*$/i;

/**
 * @param owner - Tool or CLI the name belongs to, for the error.
 * @param word - Command name or alias.
 * @returns {string} The word, checked.
 * @throws {ToolDefinitionError} When no command line could reach it.
 */
function commandWord(owner: string, word: string): string {
  if (!COMMAND_WORD.test(word)) {
    throw new ToolDefinitionError(
      `${owner}: command ${JSON.stringify(word)} must match ${COMMAND_WORD}`,
    );
  }
  return word;
}

/**
 * How a value for this property is read from one command line word.
 *
 * @param schema - Property schema.
 * @returns {FieldKind} The reading.
 */
function fieldKind(schema: SchemaNode): FieldKind {
  if (Array.isArray(schema.enum) && schema.enum.every((value) => typeof value === "string")) {
    return "enum";
  }
  const branches = Array.isArray(schema.anyOf) ? (schema.anyOf as readonly SchemaNode[]) : [];
  if (branches.some((branch) => fieldKind(branch) === "json")) return "json";
  return TYPE_KINDS.get(schema.type) ?? "string";
}

/**
 * @param schema - Property schema.
 * @returns {SchemaNode | undefined} The items of an array of text, if the schema is one.
 */
function textItems(schema: SchemaNode): SchemaNode | undefined {
  const { items } = schema;
  if (schema.type !== "array" || typeof items !== "object" || items === null) return undefined;
  if (Array.isArray(items)) return undefined;
  return unionBranches(items as SchemaNode).every(takesText) ? (items as SchemaNode) : undefined;
}

/**
 * @param branch - One branch of an item schema, unions opened.
 * @returns {boolean} Whether it takes text only, so no word turns into a number or `null`.
 */
function takesText(branch: SchemaNode): boolean {
  if (branch.type === "string" || typeof branch.const === "string") return true;
  return Array.isArray(branch.enum) && branch.enum.every((value) => typeof value === "string");
}

interface CliHints {
  /** The `positional` hint with `rest` at the end. */
  readonly positional: readonly string[];
  readonly plain: readonly string[];
  readonly rest: readonly string[];
  readonly short: Readonly<Record<string, string>>;
  readonly stdin: readonly string[];
}

/**
 * @param tool - Tool to read.
 * @returns {CliHints} Its hints, every key a property of the tool.
 * @throws {ToolDefinitionError} When a hint names a property the tool lacks, or a positional twice.
 */
function cliHints(tool: ToolDefinition): CliHints {
  const cli = tool.cli ?? {};
  const rest = cli.rest === undefined ? [] : [cli.rest];
  const hints = {
    positional: [...(cli.positional ?? []), ...rest],
    plain: cli.plain ?? [],
    rest,
    short: cli.short ?? {},
    stdin: cli.stdin ?? [],
  };
  const properties = tool.input.properties as Readonly<Record<string, unknown>>;
  const named = [...hints.positional, ...hints.plain, ...Object.keys(hints.short), ...hints.stdin];
  for (const key of named) {
    if (!Object.hasOwn(properties, key)) {
      throw new ToolDefinitionError(`${tool.name}: cli hint names unknown property ${key}`);
    }
  }
  assertPositionals(tool, hints);
  return hints;
}

/**
 * @param tool - Tool the hints belong to.
 * @param hints - Its hints, every key a property.
 * @throws {ToolDefinitionError} When a positional is listed twice, or `plain` names a property that
 *   takes no positional word.
 */
function assertPositionals(tool: ToolDefinition, hints: CliHints): void {
  const { positional } = hints;
  const repeated = positional.find((key, index) => positional.indexOf(key) !== index);
  if (repeated !== undefined) {
    throw new ToolDefinitionError(`${tool.name}: cli hint lists positional ${repeated} twice`);
  }
  const flag = hints.plain.find((key) => !positional.includes(key));
  if (flag !== undefined) {
    throw new ToolDefinitionError(`${tool.name}: plain property ${flag} must be positional`);
  }
}

/**
 * Reads a tool's schema and hints into command line fields.
 *
 * @param tool - Tool to read.
 * @returns {Field[]} One field per property, positional ones in hint order first.
 * @throws {ToolDefinitionError} When a hint names a property the tool lacks, or two properties share a flag.
 */
function toolFields(tool: ToolDefinition): Field[] {
  const properties = tool.input.properties as Readonly<Record<string, SchemaNode>>;
  const { positional, plain, rest, short, stdin } = cliHints(tool);
  const keys = [
    ...positional,
    ...Object.keys(properties).filter((key) => !positional.includes(key)),
  ];
  const required = (tool.input.required as readonly string[] | undefined) ?? [];
  const flags = new Set<string>();
  const fields = keys.map((key): Field => {
    const field: Field = {
      key,
      schema: properties[key] ?? {},
      required: required.includes(key),
      flag: flagName(key),
      kind: fieldKind(properties[key] ?? {}),
      positional: positional.includes(key),
      plain: plain.includes(key),
      rest: rest.includes(key),
      restItems: rest.includes(key) ? textItems(properties[key] ?? {}) : undefined,
      short: Object.hasOwn(short, key) ? short[key] : undefined,
      stdin: stdin.includes(key),
    };
    assertField(tool, field, !field.positional && flags.has(field.flag));
    assertShort(tool, field);
    if (!field.positional) flags.add(field.flag);
    return field;
  });
  assertOneOptionPerSpelling(tool, fields);
  assertRequiredPositionalsFirst(tool, fields);
  return fields;
}

/**
 * @param tool - Tool the field belongs to.
 * @param field - Field to check.
 * @throws {ToolDefinitionError} When no word can spell the flag, or it is reserved or reads as a negation.
 */
function assertFlag(tool: ToolDefinition, field: Field): void {
  if (!FLAG_WORD.test(field.flag)) {
    throw new ToolDefinitionError(
      `${tool.name}: property ${JSON.stringify(field.key)} gives the flag ${JSON.stringify(field.flag)}, which must match ${FLAG_WORD}`,
    );
  }
  if (field.kind === "boolean" && field.flag.startsWith("no-")) {
    // `util.parseArgs` reads `--no-cache` as `cache` negated, never as a flag `no-cache`.
    throw new ToolDefinitionError(
      `${tool.name}: boolean property ${field.key} cannot take a flag starting with no-; name the positive and --no-${field.flag.slice(3)} negates it`,
    );
  }
  if (RESERVED_FLAGS.has(field.flag)) {
    throw new ToolDefinitionError(
      `${tool.name}: property ${field.key} takes the reserved flag --${field.flag}`,
    );
  }
}

/**
 * @param tool - Tool the field belongs to.
 * @param field - Field to check.
 * @param taken - Whether an option before it has the same flag.
 * @throws {ToolDefinitionError} When no word can spell the flag, it is reserved or taken, or a hint does not fit the field.
 */
function assertField(tool: ToolDefinition, field: Field, taken: boolean): void {
  // A positional is never an option: its key needs no flag spelling.
  if (!field.positional) assertFlag(tool, field);
  if (taken) {
    throw new ToolDefinitionError(`${tool.name}: two properties take the flag --${field.flag}`);
  }
  if (field.positional && field.kind === "boolean") {
    throw new ToolDefinitionError(
      `${tool.name}: boolean property ${field.key} cannot be positional`,
    );
  }
  assertTextHints(tool, field);
}

/**
 * @param tool - Tool the field belongs to.
 * @param field - Field to check.
 * @throws {ToolDefinitionError} When `stdin` or `rest` sits on a property that takes no text.
 */
function assertTextHints(tool: ToolDefinition, field: Field): void {
  if (field.stdin && field.kind !== "string") {
    throw new ToolDefinitionError(`${tool.name}: stdin property ${field.key} must be a string`);
  }
  if (field.rest && field.restItems === undefined && !TEXT_KINDS.has(field.kind)) {
    throw new ToolDefinitionError(
      `${tool.name}: rest property ${field.key} must be a string or an array of strings`,
    );
  }
}

/**
 * @param tool - Tool the field belongs to.
 * @param field - Field to check.
 * @throws {ToolDefinitionError} When the short flag is no letter, is `h` or sits on a positional.
 */
function assertShort(tool: ToolDefinition, field: Field): void {
  if (field.short === undefined) return;
  if (field.positional) {
    throw new ToolDefinitionError(
      `${tool.name}: positional property ${field.key} takes no short flag`,
    );
  }
  if (!SHORT_FLAG.test(field.short)) {
    throw new ToolDefinitionError(
      `${tool.name}: short flag ${JSON.stringify(field.short)} of ${field.key} must match ${SHORT_FLAG}`,
    );
  }
  if (field.short === "h") {
    throw new ToolDefinitionError(
      `${tool.name}: property ${field.key} takes -h, which asks for help`,
    );
  }
}

/**
 * Words fill the positionals in order, so an optional one before a required
 * one would take the only word given and leave the required one empty.
 *
 * @param tool - Tool the fields belong to.
 * @param fields - The tool's fields.
 * @throws {ToolDefinitionError} When an optional positional comes before a required one.
 */
function assertRequiredPositionalsFirst(tool: ToolDefinition, fields: readonly Field[]): void {
  const positional = fields.filter((field) => field.positional);
  const optional = positional.findIndex((field) => !field.required);
  const late = positional
    .slice(optional === -1 ? positional.length : optional)
    .find((field) => field.required);
  if (late !== undefined) {
    throw new ToolDefinitionError(
      `${tool.name}: required positional ${late.key} comes after an optional one`,
    );
  }
}

/**
 * Every spelling the CLI reads for an option names one property: a boolean also
 * answers to `--no-<flag>`, so a boolean `cache` and a property `noCache`
 * would both claim `--no-cache`, and two short flags can land on one letter.
 *
 * @param tool - Tool the fields belong to.
 * @param fields - The tool's fields.
 * @throws {ToolDefinitionError} When two options share a spelling.
 */
function assertOneOptionPerSpelling(tool: ToolDefinition, fields: readonly Field[]): void {
  const owners = new Map<string, string>();
  for (const field of fields.filter((each) => !each.positional)) {
    const negation = field.kind === "boolean" ? [`--no-${field.flag}`] : [];
    const short = field.short === undefined ? [] : [`-${field.short}`];
    for (const spelling of [`--${field.flag}`, ...negation, ...short]) {
      const owner = owners.get(spelling);
      if (owner !== undefined) {
        throw new ToolDefinitionError(
          `${tool.name}: properties ${owner} and ${field.key} both answer to ${spelling}`,
        );
      }
      owners.set(spelling, field.key);
    }
  }
}

/**
 * @param field - Field to describe.
 * @returns {string} Its line in the usage text, after the flag.
 */
function fieldDescription(field: Field): string {
  const { schema } = field;
  return [
    typeof schema.description === "string" ? schema.description : "",
    field.stdin ? "(- reads stdin)" : "",
    field.required ? "(required)" : "",
  ]
    .filter((part) => part !== "")
    .join(" ");
}

/**
 * @param field - Option field.
 * @returns {string} What the value looks like in the usage text.
 */
function valueHint(field: Field): string {
  if (field.kind === "enum") return (field.schema.enum as string[]).join("|");
  return field.kind === "string" ? field.flag : field.kind;
}

/**
 * @param field - Option field.
 * @returns {string} Its long spelling in the usage text.
 */
function optionSpelling(field: Field): string {
  return field.kind === "boolean"
    ? `--[no-]${field.flag}`
    : `--${field.flag}=<${valueHint(field)}>`;
}

/**
 * A record without a prototype: a property named `toString` reads as unset
 * instead of `Object.prototype.toString`, and `__proto__` is a plain key.
 *
 * @returns {Record<string, T>} An empty record.
 */
function emptyRecord<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

/** A raw value: a word, `true`/`false` for a boolean, the words of a `rest` array. */
type RawValue = string | boolean | readonly string[];

interface ParsedWords {
  /** Raw values by property, before {@link toolInput} reads them. */
  readonly values: Readonly<Record<string, RawValue>>;
  readonly json: boolean;
  /** `--help` or `-h` before any `--`; a value or a word after `--` is not one. */
  readonly help: boolean;
  readonly errors: readonly string[];
}

/**
 * Reads the words after the command name, on `util.parseArgs` tokens. Only
 * `--flag`, `--flag=value`, for a boolean `--no-flag`, and a short flag as
 * a whole word are options. A dashed word that spells none fills a free
 * positional ({@link takeDashedText}); past that, an unknown option, a missing
 * value, a value given twice or a positional too many is a failure, never a
 * skipped word.
 *
 * @param rawArgs - Words after the command name.
 * @param fields - The command's fields.
 * @param takesJson - Whether the command takes `--json`.
 * @returns {ParsedWords} Values by property and the failures, one per line.
 */
function parseWords(
  rawArgs: readonly string[],
  fields: readonly Field[],
  takesJson: boolean,
): ParsedWords {
  const entries: Array<[string, Field | "json"]> = [
    ...fields
      .filter((field) => !field.positional)
      .map((field): [string, Field] => [field.flag, field]),
    ...(takesJson ? [["json", "json"] as [string, "json"]] : []),
  ];
  const options: Readonly<Record<string, Field | "json">> = Object.fromEntries(entries);
  const { args, origins, texts, refused } = takeDashedText(rawArgs, fields, options);
  const { tokens } = parseArgs({
    args,
    options: Object.fromEntries(
      Object.entries(options).map(([flag, field]) => [
        flag,
        field === "json"
          ? { type: "boolean" }
          : {
              type: field.kind === "boolean" ? "boolean" : "string",
              ...(field.short === undefined ? {} : { short: field.short }),
            },
      ]),
    ) as Record<string, { type: "boolean" | "string"; short?: string }>,
    strict: false,
    allowPositionals: true,
    allowNegative: true,
    tokens: true,
  });

  const ordered = inLineOrder(tokens, origins, texts);
  const positionals = ordered.map(([, word]) => word);
  const values = emptyRecord<RawValue>();
  const errors = [...landedInPlain(fields, ordered, texts), ...refused].map((word) =>
    unknownOption(options, word),
  );
  const flags = new Set<string>();
  for (const token of tokens) {
    if (token.kind !== "option") continue;
    const read = readOption(options, token, args[token.index] ?? "", Object.keys(values));
    if ("error" in read) errors.push(read.error);
    else if ("flag" in read) flags.add(read.flag);
    else values[read.key] = read.value;
  }
  return {
    values: Object.assign(values, positionalValues(fields, positionals)),
    json: flags.has("json"),
    help: flags.has("help"),
    errors: [...new Set(errors.length > 0 ? errors : extraPositionals(fields, positionals))],
  };
}

/** The line for `util.parseArgs` without the dashed text, and where each word stood. */
interface DashedText {
  readonly args: string[];
  /** Index on the original line of each word in `args`. */
  readonly origins: readonly number[];
  /** Dashed words read as positionals, with their index on the original line. */
  readonly texts: ReadonlyArray<readonly [number, string]>;
  /** Dashed words no positional is left for, which fail as unknown options. */
  readonly refused: readonly string[];
}

/**
 * Morse, PGP armor and `-5` take a positional the plain words leave free, or fail as unknown
 * options. Neither reaches `util.parseArgs`, which reads the inner `-` of `-.-.` as `--`.
 *
 * @param rawArgs - Words after the command name.
 * @param fields - The command's fields.
 * @param options - Option fields by flag, and `--json` when the command takes it.
 * @returns {DashedText} The words left for `util.parseArgs` and the dashed text.
 */
function takeDashedText(
  rawArgs: readonly string[],
  fields: readonly Field[],
  options: Readonly<Record<string, Field | "json">>,
): DashedText {
  const { dashed, plain } = scanWords(rawArgs, options);
  const free = fields.filter((field) => field.positional).length - plain;
  const taken = dashed.slice(0, Math.max(free, 0));
  const skipped = new Set(dashed);
  const origins = rawArgs.flatMap((_, index) => (skipped.has(index) ? [] : [index]));
  const word = (index: number): string => rawArgs[index] ?? "";
  return {
    args: origins.map(word),
    origins,
    texts: taken.map((index) => [index, word(index)] as const),
    refused: dashed.slice(taken.length).map(word),
  };
}

/**
 * @param rawArgs - Words after the command name.
 * @param options - Option fields by flag, and `--json` when the command takes it.
 * @returns {{ dashed: number[]; plain: number }} Dashed words that spell no option, plain words.
 */
function scanWords(
  rawArgs: readonly string[],
  options: Readonly<Record<string, Field | "json">>,
): { dashed: number[]; plain: number } {
  const dashed: number[] = [];
  let plain = 0;
  for (let index = 0; index < rawArgs.length; index++) {
    const word = rawArgs[index] ?? "";
    if (word === "--") return { dashed, plain: plain + rawArgs.length - index - 1 };
    const kind = wordKind(word, options);
    if (kind === "plain") plain++;
    else if (kind === "text") dashed.push(index);
    else if (kind === "valued") index++;
  }
  return { dashed, plain };
}

/**
 * Reads a whole word the way {@link optionField} takes its tokens.
 *
 * @param word - One word before `--`.
 * @param options - Option fields by flag, and `--json` when the command takes it.
 * @returns {"plain" | "option" | "valued" | "text"} `valued` takes the next word as its value.
 */
function wordKind(
  word: string,
  options: Readonly<Record<string, Field | "json">>,
): "plain" | "option" | "valued" | "text" {
  if (!word.startsWith("-") || word === "-") return "plain";
  if (word === "-h") return "option";
  const field = word.startsWith("--")
    ? longField(word.slice(2), options)
    : shortField(word, options);
  if (field === undefined) return "text";
  if (field === "option" || field.kind === "boolean" || word.includes("=")) return "option";
  return "valued";
}

/**
 * @param tokens - Tokens of the line without the dashed text.
 * @param origins - Index on the original line of each word `util.parseArgs` read.
 * @param texts - The dashed text with its index on the original line.
 * @returns {Array<readonly [number, string]>} Every positional word with its index on the
 *   original line, in the order the line gave them.
 */
function inLineOrder(
  tokens: ReadonlyArray<Readonly<{ kind: string; index: number; value?: string | undefined }>>,
  origins: readonly number[],
  texts: ReadonlyArray<readonly [number, string]>,
): Array<readonly [number, string]> {
  const read = tokens.flatMap((token) =>
    token.kind === "positional" ? [[origins[token.index] ?? 0, token.value ?? ""] as const] : [],
  );
  return [...texts, ...read].toSorted(([a], [b]) => a - b);
}

/**
 * An id or a key never starts with a dash, so `--withPubkey` in one is a mistyped option.
 *
 * @param fields - The command's fields.
 * @param ordered - Positional words with their index on the original line, in line order.
 * @param texts - The dashed text with its index on the original line.
 * @returns {string[]} The dashed words that would fill a `plain` positional.
 */
function landedInPlain(
  fields: readonly Field[],
  ordered: ReadonlyArray<readonly [number, string]>,
  texts: ReadonlyArray<readonly [number, string]>,
): string[] {
  const takes = fields.filter((field) => field.positional);
  const dashed = new Set(texts.map(([index]) => index));
  return ordered.flatMap(([index, word], slot) => {
    const field = takes[Math.min(slot, takes.length - 1)];
    return dashed.has(index) && field?.plain === true ? [word] : [];
  });
}

/**
 * @param spelled - A long option without its `--`, maybe with `=value`.
 * @param options - Option fields by flag, and `--json` when the command takes it.
 * @returns {Field | "option" | undefined} The field, or `option` for help, json, `--no-`.
 */
function longField(
  spelled: string,
  options: Readonly<Record<string, Field | "json">>,
): Field | "option" | undefined {
  const [name = ""] = spelled.split("=", 1);
  if (name === "help") return "option";
  const field = Object.hasOwn(options, name) ? options[name] : undefined;
  if (field !== undefined) return field === "json" ? "option" : field;
  return negatesBoolean(name, options) ? "option" : undefined;
}

/**
 * @param name - A long option name without its `--`.
 * @param options - Option fields by flag.
 * @returns {boolean} Whether the name is the `no-` form of a boolean flag.
 */
function negatesBoolean(name: string, options: Readonly<Record<string, Field | "json">>): boolean {
  const flag = name.slice(3);
  const field = name.startsWith("no-") && Object.hasOwn(options, flag) ? options[flag] : undefined;
  return field !== undefined && field !== "json" && field.kind === "boolean";
}

/**
 * @param word - A word with one leading dash.
 * @param options - Option fields by flag.
 * @returns {Field | undefined} The field whose short flag the whole word is.
 */
function shortField(
  word: string,
  options: Readonly<Record<string, Field | "json">>,
): Field | undefined {
  return Object.values(options).find(
    (field): field is Field =>
      field !== "json" && field.short !== undefined && `-${field.short}` === word,
  );
}

/**
 * @param fields - The command's fields.
 * @param positionals - Positional words in order.
 * @returns {Record<string, RawValue>} Each positional property with its word, `rest` with the
 *   others: joined by spaces for a string, one item per word for an array, empty when required.
 */
function positionalValues(
  fields: readonly Field[],
  positionals: readonly string[],
): Record<string, RawValue> {
  const takes = fields.filter((field) => field.positional);
  return Object.assign(
    emptyRecord<RawValue>(),
    Object.fromEntries(
      takes.flatMap((field, index): Array<[string, RawValue]> => {
        const words = field.rest ? positionals.slice(index) : positionals.slice(index, index + 1);
        if (field.restItems !== undefined)
          return words.length > 0 || field.required ? [[field.key, words]] : [];
        return words.length === 0 ? [] : [[field.key, words.join(" ")]];
      }),
    ),
  );
}

/**
 * @param fields - The command's fields.
 * @param positionals - Positional words in order.
 * @returns {string[]} The failure for words no positional takes.
 */
function extraPositionals(fields: readonly Field[], positionals: readonly string[]): string[] {
  if (fields.some((field) => field.rest)) return [];
  const extra = positionals.length - fields.filter((field) => field.positional).length;
  if (extra <= 0) return [];
  return [`Invalid arguments: ${extra} unexpected positional argument${extra === 1 ? "" : "s"}`];
}

interface OptionToken {
  readonly name: string;
  readonly rawName: string;
  readonly value?: string | undefined;
  readonly inlineValue?: boolean | undefined;
}

type OptionRead =
  | { readonly error: string }
  | { readonly flag: "json" | "help" }
  | { readonly key: string; readonly value: string | boolean };

/**
 * `-xh` expands to `-x` and `-h`; only the whole word `-h` asks for help.
 *
 * @param token - The token `util.parseArgs` made.
 * @param word - The command line word it came from.
 * @returns {boolean} Whether the token is `--help` or the word `-h`.
 */
function asksHelp(token: OptionToken, word: string): boolean {
  return token.rawName === "--help" || word === "-h";
}

/**
 * @param options - Option fields by flag, and `--json` when the command takes it.
 * @param token - The token `util.parseArgs` made.
 * @param word - The command line word it came from.
 * @returns {Field | "json" | "help" | undefined} What the token names under a spelling it takes.
 */
function optionField(
  options: Readonly<Record<string, Field | "json">>,
  token: OptionToken,
  word: string,
): Field | "json" | "help" | undefined {
  if (asksHelp(token, word)) return "help";
  const field = Object.hasOwn(options, token.name) ? options[token.name] : undefined;
  if (field === "json") return token.rawName === "--json" ? field : undefined;
  return field !== undefined && spells(field, token, word) ? field : undefined;
}

/**
 * `--flag`, `--no-flag` for a boolean, or the short flag as a whole word only,
 * since `util.parseArgs` would read a mistyped `-provider` as `-p rovider`.
 *
 * @param field - Field the token's name points to.
 * @param token - The token `util.parseArgs` made.
 * @param word - The command line word it came from.
 * @returns {boolean} Whether the token is a spelling the field takes.
 */
function spells(field: Field, token: OptionToken, word: string): boolean {
  if (token.rawName === `--${field.flag}`) return true;
  if (field.short !== undefined && token.rawName === `-${field.short}`)
    return word === token.rawName;
  return field.kind === "boolean" && token.rawName === `--no-${field.flag}`;
}

/**
 * @param options - Option fields by flag, and `--json` when the command takes it.
 * @param word - The command line word that names no option.
 * @returns {string} The failure, with every flag the command takes.
 */
function unknownOption(options: Readonly<Record<string, Field | "json">>, word: string): string {
  const flags = Object.entries(options).map(([flag, each]) =>
    each === "json" || each.short === undefined ? `--${flag}` : `--${flag} (-${each.short})`,
  );
  const takes = flags.length > 0 ? flags.join(", ") : "no options";
  return `Invalid arguments: unknown option ${JSON.stringify(word)}; takes ${takes}`;
}

/**
 * @param options - Option fields by flag, and `--json` when the command takes it.
 * @param token - The token `util.parseArgs` made.
 * @param word - The command line word it came from.
 * @param seen - Properties set by earlier words.
 * @returns {OptionRead} The value it sets, `--json`, or the failure.
 */
function readOption(
  options: Readonly<Record<string, Field | "json">>,
  token: OptionToken,
  word: string,
  seen: readonly string[],
): OptionRead {
  const field = optionField(options, token, word);
  if (field === undefined) return { error: unknownOption(options, word) };
  if (field === "json" || field === "help") {
    return token.inlineValue === true
      ? { error: `Invalid arguments: ${token.rawName} takes no value` }
      : { flag: field };
  }
  const problem = optionProblem(field, token, seen.includes(field.key));
  if (problem !== undefined) return { error: `Invalid arguments: --${field.flag} ${problem}` };
  const value = field.kind === "boolean" ? token.rawName !== `--no-${field.flag}` : token.value;
  return { key: field.key, value: value ?? "" };
}

/**
 * @param field - The option's field.
 * @param token - Its token.
 * @param seen - Whether an earlier word set the property already.
 * @returns {string | undefined} What is wrong with the option, if anything.
 */
function optionProblem(field: Field, token: OptionToken, seen: boolean): string | undefined {
  if (seen) return "given more than once";
  if (field.kind === "boolean") return token.inlineValue === true ? "takes no value" : undefined;
  return token.value === undefined ? "needs a value" : undefined;
}

/**
 * Reads stdin as strict UTF-8. A lenient decode would turn each invalid byte
 * into U+FFFD, and a tool hashing or encoding the text would answer for other
 * input without a word; binary data needs a command of the package's own.
 *
 * @returns {string | undefined} The text, or nothing when stdin is not UTF-8.
 */
function readStdin(): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(readFileSync(0));
  } catch (error) {
    if (error instanceof TypeError) return undefined;
    throw error;
  }
}

/** An `integer` word: decimal digits, maybe signed. */
const DECIMAL_INTEGER = /^[+-]?\d+$/;

/** A `number` word: decimal, with an optional fraction and exponent. */
const DECIMAL_NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;

/**
 * Reads a number word as written: `Number` alone takes `0x10`, and an empty word as zero.
 *
 * @param integer - Whether the schema wants an `integer` rather than any `number`.
 * @param word - The word.
 * @returns {{ value: number } | { error: string }} The number, or the core's type error.
 */
function numberValue(integer: boolean, word: string): { value: number } | { error: string } {
  const value = Number(word);
  const written = (integer ? DECIMAL_INTEGER : DECIMAL_NUMBER).test(word);
  if (written && Number.isFinite(value)) return { value };
  return { error: integer ? "must be integer" : "must be number" };
}

/** Literal values a word can spell; an object or array never comes from one word. */
const LITERAL_TYPES = new Set(["string", "number", "boolean"]);

/** Types whose every value is a literal a word spells. */
const TYPE_LITERALS = new Map<unknown, readonly unknown[]>([
  ["null", [null]],
  ["boolean", [true, false]],
]);

/**
 * @param values - Every value the branch allows, from `const`, `enum` or its type.
 * @param word - The word.
 * @returns {{ value: unknown } | undefined} The literal the word spells exactly, if any.
 */
function literalValue(values: readonly unknown[], word: string): { value: unknown } | undefined {
  const spelled = (item: unknown) =>
    (item === null || LITERAL_TYPES.has(typeof item)) && String(item) === word;
  return values.some(spelled) ? { value: values.find(spelled) } : undefined;
}

/**
 * @param branch - One branch of a union.
 * @param word - The word.
 * @returns {{ value: unknown } | undefined} What the branch reads the word as, if it takes it at all.
 */
function branchValue(branch: SchemaNode, word: string): { value: unknown } | undefined {
  if (Object.hasOwn(branch, "const")) return literalValue([branch.const], word);
  if (Array.isArray(branch.enum)) return literalValue(branch.enum, word);
  const literals = TYPE_LITERALS.get(branch.type);
  if (literals !== undefined) return literalValue(literals, word);
  if (TYPE_KINDS.get(branch.type) !== "number") return undefined;
  const read = numberValue(branch.type === "integer", word);
  return "value" in read ? read : undefined;
}

/**
 * @param schema - Property schema.
 * @returns {readonly SchemaNode[]} Its branches, with nested combinators and type lists opened.
 */
function unionBranches(schema: SchemaNode): readonly SchemaNode[] {
  const union = schema.anyOf ?? schema.oneOf ?? schema.allOf;
  if (Array.isArray(union)) return (union as readonly SchemaNode[]).flatMap(unionBranches);
  if (!Array.isArray(schema.type)) return [schema];
  return (schema.type as readonly unknown[]).map((type) => ({ ...schema, type }));
}

/**
 * The first reading of the word the schema accepts: the text itself, then what each branch spells.
 *
 * @param schema - Property schema, a union or not.
 * @param word - The word.
 * @returns {unknown} The value, or the word for validation to judge.
 */
function wordValue(schema: SchemaNode, word: string): unknown {
  const readings = [
    word,
    ...unionBranches(schema).flatMap((branch) => {
      const read = branchValue(branch, word);
      return read === undefined ? [] : [read.value];
    }),
  ];
  const index = readings.findIndex((value) => Value.Check(schema, value));
  return index === -1 ? word : readings[index];
}

/**
 * @param field - Field the word belongs to.
 * @param raw - What {@link parseWords} read for it.
 * @returns {{ value: unknown } | { error: string }} The value, or why there is none.
 */
function fieldValue(field: Field, raw: string | boolean): { value: unknown } | { error: string } {
  if (field.stdin && raw === "-") {
    const text = readStdin();
    return text === undefined ? { error: "stdin is not UTF-8 text" } : { value: text };
  }
  if (typeof raw !== "string") return { value: raw };
  if (field.kind === "number") return numberValue(field.schema.type === "integer", raw);
  if (field.kind === "string") return { value: wordValue(field.schema, raw) };
  if (field.kind !== "json") return { value: raw };
  try {
    return { value: JSON.parse(raw) as unknown };
  } catch {
    return { error: "must be JSON" };
  }
}

/**
 * Builds the tool input from parsed arguments. Numbers are read as decimals,
 * booleans come from the flag, objects and arrays are JSON (a `rest` array
 * takes its words instead), any other word is its first reading the schema
 * accepts, and nothing is bent to fit it: {@link invokeTool} validates as on
 * every surface.
 *
 * @param fields - The command's fields.
 * @param values - Raw values by property, from {@link parseWords}.
 * @returns {unknown} The input object.
 * @throws {ToolInputError} When a number or a JSON value does not read.
 */
function toolInput(fields: readonly Field[], values: Readonly<Record<string, RawValue>>): unknown {
  const input = emptyRecord<unknown>();
  const fromStdin = fields.filter((field) => field.stdin && values[field.key] === "-");
  if (fromStdin.length > 1) {
    throw new ToolInputError([
      `Invalid arguments: stdin can feed one argument, not ${fromStdin.map(fieldWord).join(" and ")}`,
    ]);
  }
  const errors: string[] = [];
  for (const field of fields) {
    const raw = values[field.key];
    if (raw === undefined) continue;
    const read =
      typeof raw === "object"
        ? { value: raw.map((word) => wordValue(field.restItems ?? {}, word)) }
        : fieldValue(field, raw);
    if ("error" in read) errors.push(`Invalid arguments at ${fieldWord(field)}: ${read.error}`);
    else input[field.key] = read.value;
  }
  if (errors.length > 0) throw new ToolInputError(errors);
  return input;
}

/**
 * @param field - A field of the command.
 * @returns {string} As the usage spells it: `<ID>` or `[WORDS...]`, or `--limit` for a flag.
 */
function fieldWord(field: Field): string {
  if (!field.positional) return `--${field.flag}`;
  const name = `${field.flag.toUpperCase()}${field.rest ? "..." : ""}`;
  return field.required ? `<${name}>` : `[${name}]`;
}

/**
 * @param field - The field the pointer starts at.
 * @param inner - Pointer tokens below the field, still escaped.
 * @returns {string} The place in CLI words, like `word 2 of <WORDS...>` or `/x of --point`.
 */
function placeIn(field: Field, inner: readonly string[]): string {
  if (inner.length === 0) return fieldWord(field);
  const [index = ""] = inner;
  if (field.restItems !== undefined && inner.length === 1 && /^\d+$/.test(index)) {
    return `word ${Number(index) + 1} of ${fieldWord(field)}`;
  }
  return `/${inner.join("/")} of ${fieldWord(field)}`;
}

/**
 * Says a schema failure the way the line was typed: `--limit`, not `/limit`.
 *
 * @param fields - The command's fields.
 * @param issue - The failure as the core reports it.
 * @returns {string[]} Its lines, or the core's own line when the place is no word of the command.
 */
function cliIssueLines(fields: readonly Field[], issue: InputIssue): string[] {
  const byKey = (key: string) => fields.find((field) => field.key === key);
  if (issue.at === "" && issue.missing !== undefined) {
    return issue.missing.map((key) => {
      const field = byKey(key);
      return `Invalid arguments: missing ${field ? fieldWord(field) : JSON.stringify(key)}`;
    });
  }
  const [, first, ...inner] = issue.at.split("/");
  const field =
    first === undefined ? undefined : byKey(first.replaceAll("~1", "/").replaceAll("~0", "~"));
  if (field === undefined) return [issue.line];
  return [`Invalid arguments at ${placeIn(field, inner)}: ${issue.problem}`];
}

/**
 * Validates first, so CLI words go to this command's own failures, not to its executor's.
 *
 * @param tool - The command's tool.
 * @param fields - Its fields.
 * @param input - The input built from the line.
 * @throws {ToolInputError} When the input fails the schema, one line per failure.
 */
function checkInput(tool: ToolDefinition, fields: readonly Field[], input: unknown): void {
  const checked = validateInput(tool, input);
  if (checked.ok) return;
  const lines = checked.issues.flatMap((issue) => cliIssueLines(fields, issue));
  throw new ToolInputError(lines.length > 0 ? [...new Set(lines)] : checked.lines, checked.issues);
}

/**
 * @param stream - Where to write.
 * @param text - Text, given a trailing newline when it lacks one.
 */
function writeLine(stream: "stdout" | "stderr", text: string): void {
  process[stream].write(text.endsWith("\n") ? text : `${text}\n`);
}

/**
 * Prints an error the CLI expects and sets exit code 1.
 *
 * @param lines - Failure lines.
 */
function fail(lines: readonly string[]): void {
  writeLine("stderr", lines.map(sanitizeLine).join("\n"));
  process.exitCode = 1;
}

/**
 * Turns expected errors into {@link fail}; any other error goes on with its stack.
 *
 * @param options - CLI options.
 * @param error - What the command threw.
 */
function handleError(options: CliOptions, error: unknown): void {
  if (error instanceof ToolInputError) fail(error.lines);
  else if (options.expected?.(error) === true) {
    fail([error instanceof Error ? error.message : String(error)]);
  } else throw error;
}

/**
 * @param details - Tool details.
 * @returns {string} Pretty JSON; a bigint becomes its decimal string, no details `null`.
 */
function detailsJson(details: unknown): string {
  // `JSON.stringify` answers `undefined`, not a string, for undefined details.
  const json =
    (JSON.stringify(
      details,
      (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value),
      2,
    ) as string | undefined) ?? "null";
  return json.replaceAll(
    JSON_FORGING,
    (character) => `\\u${(character.codePointAt(0) ?? 0).toString(16).padStart(4, "0")}`,
  );
}

/**
 * What `JSON.stringify` leaves literal although a terminal acts on it: DEL and
 * C1, the bidi marks, overrides and isolates, and the Unicode line and
 * paragraph separators. They only occur inside strings, so a `\u` escape
 * keeps the parsed details the same.
 */
const JSON_FORGING =
  /* oxlint-disable-next-line no-control-regex */
  /[\u007F-\u009F\u061C\u200E\u200F\u2028\u2029\u202A-\u202E\u2066-\u206F]/g;

/** Cuts the progress line between characters a terminal draws, so an emoji stays whole. */
const GRAPHEMES = new Intl.Segmenter();

/** Code points a terminal draws two cells wide: emoji and the East Asian wide blocks. */
const WIDE =
  /^(?:\p{Extended_Pictographic}|[\u1100-\u115F\u231A\u231B\u2329\u232A\u2630-\u2637\u268A-\u268F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DFF\u4E00-\u9FFF\uA000-\uA4CF\uA960-\uA97F\uAC00-\uD7A3\uF900-\uFAFF\uFE10-\uFE19\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6\u{16FE0}-\u{18DFF}\u{1AFF0}-\u{1B2FF}\u{1D15E}-\u{1D164}\u{1D1BB}-\u{1D1C0}\u{1D300}-\u{1D376}\u{1F000}-\u{1FAFF}\u{20000}-\u{3FFFD}])$/u;

/** Emoji a terminal draws two cells wide whatever their code points add up to, as `1️⃣`. */
const EMOJI = /^\p{RGI_Emoji}$/v;

/** Marks that sit on the character before them and take no cell of their own. */
const ZERO_WIDTH = /^[\p{Mn}\p{Me}]$/u;

/**
 * @param point - One code point.
 * @returns {number} Cells it takes on a terminal.
 */
function pointCells(point: string): number {
  if (WIDE.test(point)) return 2;
  return ZERO_WIDTH.test(point) ? 0 : 1;
}

/**
 * @param grapheme - One grapheme.
 * @returns {number} Cells it takes on a terminal.
 */
function graphemeCells(grapheme: string): number {
  let size = 0;
  for (const point of grapheme.normalize("NFC")) size += pointCells(point);
  return Math.max(EMOJI.test(grapheme) ? 2 : 1, size);
}

/**
 * Counts no fewer cells than Node's ICU, since a short count wraps the line past the wipe.
 *
 * @param text - Line to fit.
 * @param room - Cells there are.
 * @returns {{ text: string; cells: number }} The graphemes that fit and the cells they take.
 */
function fitLine(text: string, room: number): { text: string; cells: number } {
  let fitted = "";
  let used = 0;
  for (const { segment } of GRAPHEMES.segment(text)) {
    const size = graphemeCells(segment);
    if (used + size > room) break;
    fitted += segment;
    used += size;
  }
  return { text: fitted, cells: used };
}

/** Where a call's progress goes on the command line, and how to take it back. */
interface ProgressLine {
  readonly context: Pick<ToolCallContext, "progress">;
  readonly wipe: () => void;
}

/**
 * @param message - Line from the tool, already through `sanitizeLine`.
 * @param amount - How far it has come.
 * @returns {string} The line, with `(3/10)` when the tool knows the total.
 */
function progressText(message: string, amount?: ToolProgress): string {
  const { progress, total } = amount ?? { progress: Number.NaN };
  if (!Number.isFinite(progress) || !Number.isFinite(total)) return message;
  return `${message} (${progress}/${total})`.trim();
}

/**
 * One stderr line that each progress update rewrites in place, wiped before the answer.
 * Off a terminal there's no line at all, so a pipe or a log gets the answer and nothing else.
 *
 * @returns {ProgressLine} The context to hand `invokeTool` and the wipe for after it.
 */
function progressLine(): ProgressLine {
  const stream = process.stderr;
  if (stream.isTTY !== true) return { context: {}, wipe() {} };
  let width = 0;
  /** Blanks the line and puts the cursor back at its start, where every update leaves it. */
  const wipe = (): void => {
    if (width > 0) stream.write(`\r${" ".repeat(width)}\r`);
    width = 0;
  };
  return {
    context: {
      progress(message, amount) {
        const line = fitLine(
          progressText(message, amount),
          Math.max(1, (stream.columns || 80) - 1),
        );
        wipe();
        stream.write(line.text);
        width = line.cells;
      },
    },
    wipe,
  };
}

/** One command the CLI dispatches to: a tool, a package command or `mcp`. */
interface Command {
  readonly name: string;
  readonly aliases: readonly string[];
  /** Line in the command list. */
  readonly summary: string;
  readonly fields: readonly Field[];
  /** Takes `--json`: a tool command prints its details; `mcp` has none. */
  readonly json: boolean;
  run(words: ParsedWords): Promise<void>;
}

/**
 * @param tool - Tool or package command to run.
 * @returns {Command} The command calling it.
 */
function toolCommand(tool: ToolDefinition): Command {
  const fields = toolFields(tool);
  const [summary = tool.title] = tool.description.split(/(?<=[.!?])\s/, 1);
  return {
    name: commandName(tool),
    aliases: (tool.cli?.aliases ?? []).map((alias) => commandWord(tool.name, alias)),
    summary: tool.cli?.description ?? summary,
    fields,
    json: tool.cli?.json !== false,
    async run(words) {
      const host: CliHost = { cli: true, json: words.json };
      const line = progressLine();
      let result;
      try {
        const input = toolInput(fields, words.values);
        checkInput(tool, fields, input);
        result = await invokeTool(tool, input, { ...line.context, host });
      } finally {
        line.wipe();
      }
      if (result.isError === true) {
        writeLine("stderr", sanitizeText(resultText(result)));
        process.exitCode = 1;
      } else if (words.json) {
        writeLine("stdout", detailsJson(result.details));
      } else if (result.content.length > 0) {
        writeLine("stdout", sanitizeText(resultText(result)));
        const images = result.content.filter((block) => block.type === "image").length;
        if (images > 0) writeLine("stderr", `(${images} image block(s) not printed)`);
      }
    },
  };
}

/**
 * @param options - CLI options.
 * @returns {Command} The stdio MCP server command.
 */
function mcpCommand(options: CliOptions): Command {
  return {
    name: "mcp",
    aliases: [],
    summary: `Run the ${options.name} MCP server over stdio`,
    fields: [],
    json: false,
    async run() {
      const [{ createMcpServer }, { StdioServerTransport }] = await Promise.all([
        import("./mcp.ts"),
        import("@modelcontextprotocol/server/stdio"),
      ]);
      const info = typeof options.mcp === "object" ? options.mcp : options;
      await createMcpServer(info, options.tools).connect(new StdioServerTransport());
    },
  };
}

/**
 * The definitions behind the commands, in listing order: the tools, each
 * replaced in place by a package command of its command name, then the rest
 * of the package commands.
 *
 * @param options - CLI options.
 * @returns {ToolDefinition[]} One definition per command but `mcp`.
 */
function commandTools(options: CliOptions): ToolDefinition[] {
  const own = options.commands ?? [];
  const byName = new Map(own.map((command) => [commandName(command), command]));
  const listed = options.tools.map((tool) => byName.get(commandName(tool)) ?? tool);
  return [...listed, ...own.filter((command) => !listed.includes(command))];
}

/**
 * @param options - CLI options.
 * @returns {boolean} Whether the built-in `mcp` command is on and no package command replaces it.
 */
function builtInMcp(options: CliOptions): boolean {
  return (
    options.mcp !== undefined &&
    options.mcp !== false &&
    !(options.commands ?? []).some((command) => commandName(command) === "mcp")
  );
}

/**
 * @param options - CLI options.
 * @returns {string[]} Every command name and alias, `mcp` included when built in.
 */
function commandWords(options: CliOptions): string[] {
  return [
    ...commandTools(options).flatMap((tool) => [commandName(tool), ...(tool.cli?.aliases ?? [])]),
    ...(builtInMcp(options) ? ["mcp"] : []),
  ];
}

/** A built command line interface. */
export interface Cli {
  /** Runs one command line: the words after the executable and script. */
  run(argv: readonly string[]): Promise<void>;
}

/**
 * Builds the commands and checks every definition, so a broken hint fails at
 * startup and not on the first call that reaches it.
 *
 * @param options - CLI options.
 * @returns {Cli} The CLI.
 * @throws {ToolDefinitionError} When two commands share a name or alias, a hint does not fit its schema, or `default` or `fallback` names no command.
 */
export function createCli(options: CliOptions): Cli {
  indexTools(options.tools);
  indexTools(options.commands ?? []);
  const commands = [
    ...commandTools(options).map((tool) => toolCommand(tool)),
    ...(builtInMcp(options) ? [mcpCommand(options)] : []),
  ];
  const words = commandWords(options);
  const repeated = words.find((word, index) => words.indexOf(word) !== index);
  if (repeated !== undefined) throw new ToolDefinitionError(`Two commands are named ${repeated}`);
  const missing = [options.default, options.fallback].find(
    (name) => name !== undefined && !words.includes(name),
  );
  if (missing !== undefined)
    throw new ToolDefinitionError(`${options.name}: no command ${missing}`);

  return { run: (argv) => dispatch(options, commands, normalizeArgv(options, argv)) };
}

/**
 * Applies `default` and `fallback`: an empty command line runs `default`, and
 * a first word that names no command goes to `fallback` as its first
 * argument. A leading option such as `--help` stays at the root; a lone `-`
 * is the stdin word of the fallback's positional, not an option.
 *
 * @param options - CLI options.
 * @param argv - Words after the executable and script.
 * @returns {string[]} The words to dispatch.
 */
export function normalizeArgv(options: CliOptions, argv: readonly string[]): string[] {
  const [first] = argv;
  if (first === undefined) return options.default === undefined ? [] : [options.default];
  const option = first.startsWith("-") && first !== "-";
  if (options.fallback === undefined || option || commandWords(options).includes(first)) {
    return [...argv];
  }
  return [options.fallback, ...argv];
}

/**
 * Picks the command by its first word and runs it. `--help` and `-h` count
 * only where the parse finds an option: after `--` or as an option's value
 * they are the tool's words. Every error line goes through
 * {@link sanitizeLine}, an unknown word inside `JSON.stringify`.
 *
 * @param options - CLI options.
 * @param commands - The commands.
 * @param argv - Words after {@link normalizeArgv}.
 */
async function dispatch(
  options: CliOptions,
  commands: readonly Command[],
  argv: readonly string[],
): Promise<void> {
  const [first, ...rest] = argv;
  if (argv.length === 1 && (first === "--version" || first === "-v")) {
    writeLine("stdout", sanitizeLine(options.version));
  } else if (first === "--help" || first === "-h") {
    writeLine("stdout", sanitizeText(mainUsage(options, commands)));
  } else if (first === undefined) {
    writeLine("stderr", sanitizeText(mainUsage(options, commands)));
    fail(["No command specified"]);
  } else {
    const command = commands.find((each) => each.name === first || each.aliases.includes(first));
    if (command === undefined) {
      fail([
        `Unknown command ${JSON.stringify(first)}`,
        `Run ${options.name} --help for the commands`,
      ]);
    } else {
      await runCommand(options, command, rest);
    }
  }
}

/**
 * @param options - CLI options.
 * @param command - The chosen command.
 * @param rawArgs - Words after the command name.
 */
async function runCommand(
  options: CliOptions,
  command: Command,
  rawArgs: readonly string[],
): Promise<void> {
  const words = parseWords(rawArgs, command.fields, command.json);
  if (words.help) {
    writeLine("stdout", sanitizeText(commandUsage(options, command)));
    return;
  }
  try {
    if (words.errors.length > 0) throw new ToolInputError(words.errors);
    await command.run(words);
  } catch (error) {
    handleError(options, error);
  }
}

/**
 * @param rows - Left and right column of each row.
 * @returns {string[]} The rows, indented, with the right column aligned.
 */
function table(rows: readonly (readonly [string, string])[]): string[] {
  const width = Math.max(0, ...rows.map(([left]) => left.length));
  return rows.map(([left, right]) => `  ${left.padEnd(width)}  ${right}`.trimEnd());
}

/**
 * @param options - CLI options.
 * @param commands - The commands.
 * @returns {string} The usage text of the CLI.
 */
function mainUsage(options: CliOptions, commands: readonly Command[]): string {
  return [
    `${options.description} (${options.name} v${options.version})`,
    "",
    `USAGE ${options.name} <command> [OPTIONS]`,
    "",
    "COMMANDS",
    "",
    ...table(
      commands.map((command) => [[command.name, ...command.aliases].join(", "), command.summary]),
    ),
    "",
    `Use ${options.name} <command> --help for more information about a command.`,
  ].join("\n");
}

/**
 * @param options - CLI options.
 * @param command - The command.
 * @returns {string} Its usage text.
 */
function commandUsage(options: CliOptions, command: Command): string {
  const positional = command.fields.filter((field) => field.positional);
  const flags = command.fields.filter((field) => !field.positional);
  const takesOptions = flags.length > 0 || command.json;
  const words = positional.map(fieldWord);
  const rows = [
    ...flags.map((field): [string, string] => [
      `${field.short === undefined ? "" : `-${field.short}, `}${optionSpelling(field)}`,
      fieldDescription(field),
    ]),
    ...(command.json
      ? [["--json", "Print the details as JSON instead of the text"] as [string, string]]
      : []),
    ["-h, --help", "Show this help"] as [string, string],
  ];
  return [
    `${command.summary} (${options.name} ${command.name} v${options.version})`,
    "",
    `USAGE ${[options.name, command.name, ...(takesOptions ? ["[OPTIONS]"] : []), ...words].join(" ")}`,
    ...(positional.length > 0
      ? [
          "",
          "ARGUMENTS",
          "",
          ...table(positional.map((field) => [field.flag.toUpperCase(), fieldDescription(field)])),
        ]
      : []),
    "",
    "OPTIONS",
    "",
    ...table(rows),
  ].join("\n");
}

/**
 * Ends the process once the reader of stdout or stderr is gone, as after
 * `| head -1`. Node ignores SIGPIPE, so without a listener the next write
 * throws `EPIPE` with a stack trace. The exit code stays what the command set.
 *
 * @param error - The error the stream emitted.
 */
function exitOnClosedPipe(error: Readonly<NodeJS.ErrnoException>): void {
  if (error.code !== "EPIPE") throw error;
  process.exit();
}

/**
 * Runs the CLI on `process.argv`. The CLI writes no colors; a terminal on
 * stderr only gets the progress line, which never reaches a pipe.
 *
 * @param options - CLI options.
 * @param argv - Words after the executable and script.
 */
export async function runCli(
  options: CliOptions,
  argv: readonly string[] = process.argv.slice(2),
): Promise<void> {
  process.stdout.on("error", exitOnClosedPipe);
  process.stderr.on("error", exitOnClosedPipe);
  await createCli(options).run(argv);
}
