/**
 * CLI adapter: one citty command per {@link ToolDefinition}, plus the
 * package's own commands and an optional stdio MCP server.
 *
 * A tool's properties become flags, its {@link ToolCliHints} pick positional
 * arguments and stdin, and every call goes through {@link invokeTool}, so the
 * command line validates and fails like every other surface.
 */

import { readFileSync } from "node:fs";
import { parseArgs, stripVTControlCharacters } from "node:util";

import type { ArgDef, ArgsDef, CommandContext, CommandDef, SubCommandsDef } from "citty";
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
   * The package's own commands, next to the generated ones. A command here
   * replaces a generated command of the same name, `mcp` included.
   */
  readonly commands?: SubCommandsDef;
  /** Command for an empty command line. */
  readonly default?: string;
  /** Command for a first word that names no command: `hashes sha256 x` runs `hashes hash sha256 x`. */
  readonly fallback?: string;
  /** Adds `mcp`, the tools as an MCP server over stdio. */
  readonly mcp?: boolean;
  /**
   * Errors the package throws on purpose. They print as one line with exit
   * code 1; any other error keeps citty's stack trace.
   */
  readonly expected?: (error: unknown) => boolean;
}

/** Thrown by a tool command whose words ask for `--help`; the dispatcher prints its usage. */
class HelpRequest extends Error {
  override name = "HelpRequest";
}

/** Commands built by {@link toolCommand}: they find `--help` in their own parse. */
const TOOL_COMMANDS = new WeakSet<CommandDef>();

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

/** A command word citty can dispatch to: not empty, not an option, nothing that forges a line. */
const COMMAND_WORD = /^[a-z0-9_][a-z0-9_.:-]*$/i;

/**
 * @param owner - Tool or CLI the name belongs to, for the error.
 * @param word - Command name or alias.
 * @returns {string} The word, checked.
 * @throws {ToolDefinitionError} When citty could never dispatch to it.
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
 * Every spelling citty reads for an option names one property: a boolean also
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
 * @param field - Field to declare.
 * @returns {ArgDef} The citty argument.
 */
function argDef(field: Field): ArgDef {
  const { schema } = field;
  const parts = [
    typeof schema.description === "string" ? schema.description : "",
    field.stdin ? "(- reads stdin)" : "",
    field.required ? "(Required)" : "",
  ];
  const description = parts.filter((part) => part !== "").join(" ");
  // Nothing here is required or an enum to citty: its parse differs from
  // parseWords, so it must not reject a command line on its own reading.
  if (field.positional) return { type: "positional", description, required: false };
  if (field.kind === "boolean") return { type: "boolean", description };
  return { type: "string", description, valueHint: valueHint(field) };
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
 * Reads the words after the command name. This is the only parse whose values
 * reach the tool: citty's own parse drops every `--no-*` word before it starts
 * and reads `-times` as five short flags, so it serves the usage text alone.
 * Only `--flag`, `--flag=value` and, for a boolean, `--no-flag` are options;
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
 * @param raw - What citty parsed for it.
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
 * Turns expected errors into {@link fail}; any other error goes on to citty.
 *
 * @param options - CLI options.
 * @param error - What the command threw.
 */
function handleError(options: CliOptions, error: unknown): void {
  if (error instanceof HelpRequest) throw error;
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

/**
 * @param options - CLI options.
 * @param tool - Tool to run.
 * @returns {CommandDef} The command calling it.
 */
export function toolCommand(options: CliOptions, tool: ToolDefinition): CommandDef {
  const fields = toolFields(tool);
  const args: ArgsDef = Object.fromEntries(fields.map((field) => [field.flag, argDef(field)]));
  args["json"] = { type: "boolean", description: "Print the details as JSON instead of the text" };
  const [summary = tool.title] = tool.description.split(/(?<=[.!?])\s/, 1);

  const command: CommandDef = {
    meta: {
      name: commandName(tool),
      description: tool.cli?.description ?? summary,
      ...(tool.cli?.aliases ? { alias: [...tool.cli.aliases] } : {}),
    },
    args,
    async run(context: CommandContext) {
      try {
        const words = parseWords(context.rawArgs, fields);
        if (words.help) throw new HelpRequest();
        if (words.errors.length > 0) throw new ToolInputError(words.errors);
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
      } catch (error) {
        handleError(options, error);
      }
    },
  };
  TOOL_COMMANDS.add(command);
  return command;
}

/**
 * Resolves a lazy citty command and guards its `run` with {@link handleError}.
 *
 * @param options - CLI options.
 * @param command - The package's command, as citty takes it.
 * @returns {Promise<CommandDef>} The resolved command.
 */
async function guardCommand(
  options: CliOptions,
  command: SubCommandsDef[string],
): Promise<CommandDef> {
  const resolved = await (typeof command === "function" ? command() : command);
  const run = resolved.run;
  if (run === undefined) return resolved;
  return {
    ...resolved,
    async run(context: CommandContext) {
      try {
        return (await run(context)) as unknown;
      } catch (error) {
        handleError(options, error);
        return undefined;
      }
    },
  };
}

/**
 * @param options - CLI options.
 * @returns {CommandDef} The stdio MCP server command.
 */
function mcpCommand(options: CliOptions): CommandDef {
  return {
    meta: { name: "mcp", description: `Run the ${options.name} MCP server over stdio` },
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
 * A package command replaces the generated one of its name, and the aliases go with it.
 *
 * @param options - CLI options.
 * @returns {ToolDefinition[]} The tools that keep a generated command.
 */
function generatedTools(options: CliOptions): ToolDefinition[] {
  return options.tools.filter((tool) => !Object.hasOwn(options.commands ?? {}, commandName(tool)));
}

/**
 * @param options - CLI options.
 * @param generated - Tools that keep a generated command.
 * @throws {ToolDefinitionError} When an alias or a package command name is no command word.
 */
function assertCommandWords(options: CliOptions, generated: readonly ToolDefinition[]): void {
  for (const alias of generated.flatMap((tool) => tool.cli?.aliases ?? [])) {
    commandWord(options.name, alias);
  }
  for (const name of Object.keys(options.commands ?? {})) commandWord(options.name, name);
}

/**
 * @param options - CLI options.
 * @param generated - Tools that keep a generated command.
 * @throws {ToolDefinitionError} When two generated commands, aliases or `mcp` share a name.
 */
function assertUniqueNames(options: CliOptions, generated: readonly ToolDefinition[]): void {
  assertCommandWords(options, generated);
  const mcp = options.mcp === true && !Object.hasOwn(options.commands ?? {}, "mcp");
  const names = [
    ...generated.flatMap((tool) => [commandName(tool), ...(tool.cli?.aliases ?? [])]),
    ...(mcp ? ["mcp"] : []),
  ];
  const repeated = names.find((name, index) => names.indexOf(name) !== index);
  if (repeated !== undefined) throw new ToolDefinitionError(`Two commands are named ${repeated}`);
}

/**
 * Builds the main command without loading citty.
 *
 * @param options - CLI options.
 * @returns {CommandDef} The main command.
 * @throws {ToolDefinitionError} When two commands share a name, or `default` or `fallback` names none.
 */
export function createCli(options: CliOptions): CommandDef {
  indexTools(options.tools);
  const generated = generatedTools(options);
  assertUniqueNames(options, generated);

  // Null prototype: a package command named `__proto__` stays an own key.
  const subCommands: SubCommandsDef = emptyRecord();
  for (const tool of generated) subCommands[commandName(tool)] = () => toolCommand(options, tool);
  if (options.mcp === true) subCommands["mcp"] = () => mcpCommand(options);
  for (const [name, command] of Object.entries(options.commands ?? {})) {
    subCommands[name] = () => guardCommand(options, command);
  }
  const missing = [options.default, options.fallback].find(
    (name) => name !== undefined && !Object.hasOwn(subCommands, name),
  );
  if (missing !== undefined)
    throw new ToolDefinitionError(`${options.name}: no command ${missing}`);

  return {
    meta: { name: options.name, version: options.version, description: options.description },
    subCommands,
  };
}

/**
 * Applies `default` and `fallback`. citty's own `default` runs only when no
 * command word is given, and a first word that names no command fails there,
 * so the CLI rewrites the words before citty sees them. A leading option such
 * as `--help` goes to the main command untouched. Only on the fallback path
 * are the package's commands loaded, for their aliases.
 *
 * @param options - CLI options.
 * @param argv - Words after the executable and script.
 * @returns {string[]} Words for citty.
 */
export async function normalizeArgv(
  options: CliOptions,
  argv: readonly string[],
): Promise<string[]> {
  const [first] = argv;
  if (first === undefined) return options.default === undefined ? [] : [options.default];
  // A lone `-` is the stdin word of the fallback's positional, not an option.
  const option = first.startsWith("-") && first !== "-";
  if (options.fallback === undefined || option || (await namesCommand(options, first))) {
    return [...argv];
  }
  return [options.fallback, ...argv];
}

/**
 * @param options - CLI options.
 * @param word - First word of the command line.
 * @returns {Promise<boolean>} Whether a command or alias has this name.
 */
async function namesCommand(options: CliOptions, word: string): Promise<boolean> {
  const commands = Object.values(options.commands ?? {});
  const names = new Set([
    ...generatedTools(options).flatMap((tool) => [commandName(tool), ...(tool.cli?.aliases ?? [])]),
    ...(options.mcp === true ? ["mcp"] : []),
    ...Object.keys(options.commands ?? {}),
  ]);
  if (names.has(word)) return true;
  return (await Promise.all(commands.map(commandAliases))).flat().includes(word);
}

/**
 * Loads a package command to read its aliases, as citty itself does for a
 * word that names no command.
 *
 * @param command - The package's command, as citty takes it.
 * @returns {Promise<string[]>} Its `meta.alias` entries.
 */
async function commandAliases(command: SubCommandsDef[string]): Promise<string[]> {
  const resolved = await resolveCommand(command);
  const meta = await (typeof resolved.meta === "function" ? resolved.meta() : resolved.meta);
  const alias = meta?.alias ?? [];
  return typeof alias === "string" ? [alias] : [...alias];
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
 * Runs the CLI on `process.argv`.
 *
 * citty colors its usage and errors even into a pipe and decides once, as it
 * loads, so colors are settled here: only when both streams it writes to are
 * terminals that take them. `hasColors()` already honors `NO_COLOR` and
 * `TERM=dumb`. Setting `NO_COLOR` covers a citty that loads after this point;
 * one the package imported earlier has decided already, so without colors the
 * usage and citty's error lines lose their escape sequences on the way out.
 *
 * @param options - CLI options.
 * @param argv - Words after the executable and script.
 */
export async function runCli(
  options: CliOptions,
  argv: readonly string[] = process.argv.slice(2),
): Promise<void> {
  const { stderr, stdout } = process;
  const colors = stdout.isTTY && stdout.hasColors() && stderr.isTTY && stderr.hasColors();
  if (!colors) process.env["NO_COLOR"] = "1";
  stdout.on("error", exitOnClosedPipe);
  stderr.on("error", exitOnClosedPipe);
  const main = createCli(options);
  const citty = await import("citty");
  const usage = async (command: CommandDef, parent?: CommandDef): Promise<void> => {
    const text = await citty.renderUsage(command, parent);
    writeLine("stdout", `${colors ? text : stripVTControlCharacters(text)}\n`);
  };
  await dispatch(options, main, await normalizeArgv(options, argv), {
    usage,
    run: (command, rawArgs) => citty.runCommand(command, { rawArgs: [...rawArgs] }),
  });
}

interface Dispatcher {
  readonly usage: (command: CommandDef, parent?: CommandDef) => Promise<void>;
  readonly run: (command: CommandDef, rawArgs: readonly string[]) => Promise<unknown>;
}

/**
 * Picks the command and runs it, in place of citty's `runMain`: that one
 * takes `--help` anywhere on the line, also after `--` and as an option's
 * value, and prints its errors with the raw command word in them. Here the
 * main command reads only its first word, a tool command finds `--help` in
 * its own parse, and every error line goes through {@link sanitizeLine}.
 *
 * @param options - CLI options.
 * @param main - The main command.
 * @param argv - Words after `normalizeArgv`.
 * @param citty - Usage printer and command runner.
 */
async function dispatch(
  options: CliOptions,
  main: CommandDef,
  argv: readonly string[],
  citty: Dispatcher,
): Promise<void> {
  const [first, ...rest] = argv;
  if (argv.length === 1 && (first === "--version" || first === "-v")) {
    writeLine("stdout", options.version);
    return;
  }
  if (first === undefined || first === "--help" || first === "-h") {
    await citty.usage(main);
    if (first === undefined) fail(["No command specified"]);
    return;
  }
  const command = await findCommand(main, first);
  if (command === undefined) {
    await citty.usage(main);
    fail([`Unknown command ${JSON.stringify(first)}`]);
    return;
  }
  await runCommandLine(command, main, rest, citty);
}

/**
 * @param command - The chosen command.
 * @param main - The main command, for the usage title.
 * @param rawArgs - Words after the command name.
 * @param citty - Usage printer and command runner.
 */
async function runCommandLine(
  command: CommandDef,
  main: CommandDef,
  rawArgs: readonly string[],
  citty: Dispatcher,
): Promise<void> {
  // A package command has no parse of ours: `--help` counts before any `--`.
  const end = rawArgs.includes("--") ? rawArgs.indexOf("--") : rawArgs.length;
  const help = rawArgs.slice(0, end).some((word) => word === "--help" || word === "-h");
  try {
    if (!TOOL_COMMANDS.has(command) && help) throw new HelpRequest();
    await citty.run(command, rawArgs);
  } catch (error) {
    const known =
      error instanceof HelpRequest || (error instanceof Error && error.name === "CLIError");
    if (!known) throw error;
    await citty.usage(command, main);
    if (!(error instanceof HelpRequest)) fail([error.message]);
  }
}

/**
 * @param main - The main command.
 * @param word - First word of the command line.
 * @returns {Promise<CommandDef | undefined>} The command with this name or alias.
 */
async function findCommand(main: CommandDef, word: string): Promise<CommandDef | undefined> {
  const commands = (main.subCommands ?? {}) as SubCommandsDef;
  const named = Object.hasOwn(commands, word) ? commands[word] : undefined;
  if (named !== undefined) return resolveCommand(named);
  for (const command of Object.values(commands)) {
    const resolved = await resolveCommand(command);
    if ((await commandAliases(resolved)).includes(word)) return resolved;
  }
  return undefined;
}

/**
 * @param command - A command as citty takes it: the definition, a promise or a loader.
 * @returns {Promise<CommandDef>} The definition.
 */
async function resolveCommand(command: SubCommandsDef[string]): Promise<CommandDef> {
  return await (typeof command === "function" ? command() : command);
}
