/**
 * CLI adapter: one command per {@link ToolDefinition}, plus the package's own
 * commands and an optional stdio MCP server, with no CLI library underneath.
 *
 * A tool's properties become flags, its {@link ToolCliHints} pick positional
 * arguments and stdin, and every call goes through {@link invokeTool}, so the
 * command line validates and fails like every other surface. A package
 * command is a tool definition too, one that only the CLI gets.
 */

import { readFileSync } from "node:fs";
import { parseArgs, stripVTControlCharacters } from "node:util";

import { Value } from "typebox/value";

import {
  indexTools,
  invokeTool,
  resultText,
  sanitizeLine,
  ToolDefinitionError,
  ToolInputError,
  type ToolDefinition,
} from "./index.ts";

export interface CliOptions {
  /** Executable name, also the MCP server name. */
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly tools: readonly ToolDefinition[];
  /**
   * The package's own commands, as tool definitions that only the CLI gets:
   * no MCP, Pi, OMP or AI SDK host sees them. One whose command name matches
   * a generated command, `mcp` included, takes its place. A command that
   * needs bytes, not text, reads `-` from stdin itself in `execute`.
   */
  readonly commands?: readonly ToolDefinition[];
  /** Command for an empty command line. */
  readonly default?: string;
  /** Command for a first word that names no command: `hashes sha256 x` runs `hashes hash sha256 x`. */
  readonly fallback?: string;
  /** Adds `mcp`, the tools as an MCP server over stdio. */
  readonly mcp?: boolean;
  /**
   * Errors the package throws on purpose. They print as one line with exit
   * code 1; any other error keeps its stack trace.
   */
  readonly expected?: (error: unknown) => boolean;
}

/** Flags every tool command answers itself. */
const RESERVED_FLAGS = new Set(["help", "version", "json"]);

type FieldKind = "string" | "number" | "boolean" | "enum" | "json";

interface Field {
  readonly key: string;
  readonly schema: SchemaNode;
  readonly required: boolean;
  readonly flag: string;
  readonly kind: FieldKind;
  readonly positional: boolean;
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
 * Reads a tool's schema and hints into command line fields.
 *
 * @param tool - Tool to read.
 * @returns {Field[]} One field per property, positional ones in hint order first.
 * @throws {ToolDefinitionError} When a hint names a property the tool lacks, or two properties share a flag.
 */
function toolFields(tool: ToolDefinition): Field[] {
  const properties = tool.input.properties as Readonly<Record<string, SchemaNode>>;
  const positional = tool.cli?.positional ?? [];
  const stdin = tool.cli?.stdin ?? [];
  for (const key of [...positional, ...stdin]) {
    if (!Object.hasOwn(properties, key)) {
      throw new ToolDefinitionError(`${tool.name}: cli hint names unknown property ${key}`);
    }
  }
  const repeated = positional.find((key, index) => positional.indexOf(key) !== index);
  if (repeated !== undefined) {
    throw new ToolDefinitionError(`${tool.name}: cli hint lists positional ${repeated} twice`);
  }

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
      stdin: stdin.includes(key),
    };
    if (RESERVED_FLAGS.has(field.flag)) {
      throw new ToolDefinitionError(
        `${tool.name}: property ${key} takes the reserved flag --${field.flag}`,
      );
    }
    if (flags.has(field.flag)) {
      throw new ToolDefinitionError(`${tool.name}: two properties take the flag --${field.flag}`);
    }
    if (field.positional && field.kind === "boolean") {
      throw new ToolDefinitionError(`${tool.name}: boolean property ${key} cannot be positional`);
    }
    if (field.stdin && field.kind !== "string") {
      throw new ToolDefinitionError(`${tool.name}: stdin property ${key} must be a string`);
    }
    flags.add(field.flag);
    return field;
  });
  assertOneOptionPerSpelling(tool, fields);
  return fields;
}

/**
 * Every spelling the CLI reads for an option names one property: a boolean also
 * answers to `--no-<flag>`, so a boolean `cache` and a property `noCache`
 * would both claim `--no-cache`.
 *
 * @param tool - Tool the fields belong to.
 * @param fields - The tool's fields.
 * @throws {ToolDefinitionError} When two options share a spelling.
 */
function assertOneOptionPerSpelling(tool: ToolDefinition, fields: readonly Field[]): void {
  const owners = new Map<string, string>();
  for (const field of fields.filter((each) => !each.positional)) {
    const negation = field.kind === "boolean" ? [`no-${field.flag}`] : [];
    for (const spelling of [field.flag, ...negation]) {
      const owner = owners.get(spelling);
      if (owner !== undefined) {
        throw new ToolDefinitionError(
          `${tool.name}: properties ${owner} and ${field.key} both answer to --${spelling}`,
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
 * A record without a prototype: a property named `toString` reads as unset
 * instead of `Object.prototype.toString`, and `__proto__` is a plain key.
 *
 * @returns {Record<string, T>} An empty record.
 */
function emptyRecord<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

interface ParsedWords {
  /** Raw values by property: a string, or `true`/`false` for a boolean. */
  readonly values: Readonly<Record<string, string | boolean>>;
  readonly json: boolean;
  /** `--help` or `-h` before any `--`; a value or a word after `--` is not one. */
  readonly help: boolean;
  readonly errors: readonly string[];
}

/**
 * Reads the words after the command name, on `util.parseArgs` tokens. Only
 * `--flag`, `--flag=value` and, for a boolean, `--no-flag` are options;
 * an unknown option, a single dash before a name, a missing value, a value
 * given twice or a positional too many is a failure, never a skipped word.
 *
 * @param rawArgs - Words after the command name.
 * @param fields - The command's fields.
 * @returns {ParsedWords} Values by property and the failures, one per line.
 */
function parseWords(rawArgs: readonly string[], fields: readonly Field[]): ParsedWords {
  const options: Readonly<Record<string, Field>> = Object.fromEntries(
    fields.filter((field) => !field.positional).map((field) => [field.flag, field]),
  );
  const { tokens } = parseArgs({
    args: [...rawArgs],
    options: Object.fromEntries([
      ...Object.values(options).map((field) => [
        field.flag,
        { type: field.kind === "boolean" ? "boolean" : "string" },
      ]),
      ["json", { type: "boolean" }],
    ]) as Record<string, { type: "boolean" | "string" }>,
    strict: false,
    allowPositionals: true,
    allowNegative: true,
    tokens: true,
  });

  const values = emptyRecord<string | boolean>();
  const errors: string[] = [];
  const positionals: string[] = [];
  const flags = new Set<string>();
  for (const token of tokens) {
    if (token.kind === "positional") positionals.push(token.value);
    if (token.kind !== "option") continue;
    const read = readOption(options, token, rawArgs[token.index] ?? "", Object.keys(values));
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

/**
 * @param fields - The command's fields.
 * @param positionals - Positional words in order.
 * @returns {Record<string, string>} Each positional property with its word.
 */
function positionalValues(
  fields: readonly Field[],
  positionals: readonly string[],
): Record<string, string> {
  const takes = fields.filter((field) => field.positional);
  return Object.assign(
    emptyRecord<string>(),
    Object.fromEntries(
      takes.flatMap((field, index) => {
        const value = positionals[index];
        return value === undefined ? [] : [[field.key, value]];
      }),
    ),
  );
}

/**
 * @param fields - The command's fields.
 * @param positionals - Positional words in order.
 * @returns {string[]} The failure when there are more words than positional properties.
 */
function extraPositionals(fields: readonly Field[], positionals: readonly string[]): string[] {
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
 * @param options - Option fields by flag.
 * @param token - The token `util.parseArgs` made.
 * @returns {Field | "json" | "help" | undefined} What the token names under a spelling it takes.
 */
function optionField(
  options: Readonly<Record<string, Field>>,
  token: OptionToken,
): Field | "json" | "help" | undefined {
  if (token.rawName === "--json") return "json";
  if (token.rawName === "--help" || token.rawName === "-h") return "help";
  const field = Object.hasOwn(options, token.name) ? options[token.name] : undefined;
  if (field === undefined || token.rawName === `--${token.name}`) return field;
  return token.rawName === `--no-${token.name}` && field.kind === "boolean" ? field : undefined;
}

/**
 * @param options - Option fields by flag.
 * @param token - The token `util.parseArgs` made.
 * @param word - The command line word it came from.
 * @param seen - Properties set by earlier words.
 * @returns {OptionRead} The value it sets, `--json`, or the failure.
 */
function readOption(
  options: Readonly<Record<string, Field>>,
  token: OptionToken,
  word: string,
  seen: readonly string[],
): OptionRead {
  const field = optionField(options, token);
  if (field === undefined) {
    const takes = [...Object.keys(options), "json"].map((flag) => `--${flag}`).join(", ");
    return { error: `Invalid arguments: unknown option ${JSON.stringify(word)}; takes ${takes}` };
  }
  if (field === "json" || field === "help") {
    return token.inlineValue === true
      ? { error: `Invalid arguments: ${token.rawName} takes no value` }
      : { flag: field };
  }
  const problem = optionProblem(field, token, seen.includes(field.key));
  if (problem !== undefined) return { error: `Invalid arguments: --${field.flag} ${problem}` };
  const value = field.kind === "boolean" ? token.rawName === `--${field.flag}` : token.value;
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

/**
 * @param field - Field the word belongs to.
 * @param raw - What {@link parseWords} read for it.
 * @returns {{ value: unknown } | { error: string }} The value before TypeBox conversion, or why there is none.
 */
function fieldValue(field: Field, raw: unknown): { value: unknown } | { error: string } {
  if (field.stdin && raw === "-") {
    const text = readStdin();
    return text === undefined ? { error: "stdin is not UTF-8 text" } : { value: text };
  }
  if (field.kind !== "json" || typeof raw !== "string") return { value: raw };
  try {
    return { value: JSON.parse(raw) as unknown };
  } catch {
    return { error: "must be JSON" };
  }
}

/**
 * Builds the tool input from parsed arguments. Numbers and booleans in the
 * schema are converted from their text by TypeBox; objects and arrays are
 * JSON. The result still goes through {@link invokeTool} validation.
 *
 * @param tool - Tool to call.
 * @param fields - The command's fields.
 * @param values - Raw values by property, from {@link parseWords}.
 * @returns {unknown} The input object.
 * @throws {ToolInputError} When a JSON value does not parse.
 */
function toolInput(
  tool: ToolDefinition,
  fields: readonly Field[],
  values: Readonly<Record<string, string | boolean>>,
): unknown {
  const input = emptyRecord<unknown>();
  const fromStdin = fields.filter((field) => field.stdin && values[field.key] === "-");
  if (fromStdin.length > 1) {
    throw new ToolInputError([
      `Invalid arguments: stdin can feed one argument, not ${fromStdin.map((field) => field.key).join(" and ")}`,
    ]);
  }
  const errors: string[] = [];
  for (const field of fields) {
    const raw = values[field.key];
    if (raw === undefined) continue;
    const read = fieldValue(field, raw);
    if ("error" in read) errors.push(`Invalid arguments at /${field.key}: ${read.error}`);
    else input[field.key] = read.value;
  }
  if (errors.length > 0) throw new ToolInputError(errors);
  return Value.Convert(tool.input, input);
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
function sanitizeText(text: string): string {
  return stripVTControlCharacters(text.replaceAll(/\r\n?/g, "\n"))
    .replaceAll(FORGING, "")
    .replaceAll(/[\u2028\u2029]/g, " ");
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

/** One command the CLI dispatches to: a tool, a package command or `mcp`. */
interface Command {
  readonly name: string;
  readonly aliases: readonly string[];
  /** Line in the command list. */
  readonly summary: string;
  readonly fields: readonly Field[];
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
    async run(words) {
      const result = await invokeTool(tool, toolInput(tool, fields, words.values));
      if (result.isError === true) {
        writeLine("stderr", sanitizeText(resultText(result)));
        process.exitCode = 1;
      } else if (words.json) {
        writeLine("stdout", detailsJson(result.details));
      } else {
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
    async run() {
      const [{ createMcpServer }, { StdioServerTransport }] = await Promise.all([
        import("./mcp.ts"),
        import("@modelcontextprotocol/server/stdio"),
      ]);
      await createMcpServer(options, options.tools).connect(new StdioServerTransport());
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
    options.mcp === true &&
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
    writeLine("stdout", options.version);
  } else if (first === "--help" || first === "-h") {
    writeLine("stdout", mainUsage(options, commands));
  } else if (first === undefined) {
    writeLine("stderr", mainUsage(options, commands));
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
  const words = parseWords(rawArgs, command.fields);
  if (words.help) {
    writeLine("stdout", commandUsage(options, command));
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
  const words = positional.map((field) => {
    const name = field.flag.toUpperCase();
    return field.required ? `<${name}>` : `[${name}]`;
  });
  const rows = [
    ...flags.map((field): [string, string] => [
      field.kind === "boolean" ? `--[no-]${field.flag}` : `--${field.flag}=<${valueHint(field)}>`,
      fieldDescription(field),
    ]),
    ["--json", "Print the details as JSON instead of the text"] as [string, string],
    ["-h, --help", "Show this help"] as [string, string],
  ];
  return [
    `${command.summary} (${options.name} ${command.name} v${options.version})`,
    "",
    `USAGE ${[options.name, command.name, "[OPTIONS]", ...words].join(" ")}`,
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
 * Runs the CLI on `process.argv`. The CLI writes no colors, so nothing
 * depends on the terminal it writes to.
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
