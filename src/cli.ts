/**
 * CLI adapter: one citty command per {@link ToolDefinition}, plus the
 * package's own commands and an optional stdio MCP server.
 *
 * A tool's properties become flags, its {@link ToolCliHints} pick positional
 * arguments and stdin, and every call goes through {@link invokeTool}, so the
 * command line validates and fails like every other surface.
 */

import { readFileSync } from "node:fs";
import { stripVTControlCharacters } from "node:util";

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
  if (tool.cli?.command !== undefined) return tool.cli.command;
  const separator = tool.name.indexOf("_");
  return (separator === -1 ? tool.name : tool.name.slice(separator + 1)).replaceAll("_", "-");
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
  return keys.map((key): Field => {
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
}

/**
 * @param field - Field to declare.
 * @returns {ArgDef} The citty argument.
 */
function argDef(field: Field): ArgDef {
  const { schema, required } = field;
  const stated = typeof schema.description === "string" ? schema.description : "";
  const description = field.stdin ? `${stated} (- reads stdin)`.trim() : stated;
  if (field.positional) return { type: "positional", description, required };
  if (field.kind === "boolean") return { type: "boolean", description };
  if (field.kind === "enum") {
    return { type: "enum", description, required, options: [...(schema.enum as string[])] };
  }
  const valueHint = field.kind === "string" ? {} : { valueHint: field.kind };
  return { type: "string", description, required, ...valueHint };
}

/** The options a tool command takes, under every spelling citty reads; `null` is `--json`. */
type OptionTable = Readonly<Record<string, Field | null>>;

/**
 * @param fields - The command's fields.
 * @returns {OptionTable} Options by flag, property name and, for a boolean, `no-` flag.
 */
function optionTable(fields: readonly Field[]): OptionTable {
  const options: Record<string, Field | null> = {};
  for (const field of fields.filter((each) => !each.positional)) {
    options[field.flag] = field;
    options[field.key] = field;
    if (field.kind === "boolean") options[`no-${field.flag}`] = field;
  }
  options["json"] = null;
  return options;
}

interface OptionScan {
  readonly error?: string;
  /** Property whose value the option sets. */
  readonly key?: string;
  /** The option takes the next word as its value. */
  readonly takesValue: boolean;
}

/**
 * @param word - The word, starting with `-`.
 * @param options - Options the command takes.
 * @param seen - Properties set by earlier options.
 * @returns {OptionScan} What the word does.
 */
function scanOption(word: string, options: OptionTable, seen: readonly string[]): OptionScan {
  const [name = "", ...value] = word.replace(/^--?/, "").split("=");
  if (!Object.hasOwn(options, name)) {
    const takes = [...new Set(Object.values(options).map((field) => field?.flag ?? "json"))];
    return {
      error: `Invalid arguments: unknown option ${JSON.stringify(word)}; takes ${takes.map((flag) => `--${flag}`).join(", ")}`,
      takesValue: false,
    };
  }
  const field = options[name];
  if (field === undefined || field === null || field.kind === "boolean")
    return { takesValue: false };
  return {
    ...(seen.includes(field.key)
      ? { error: `Invalid arguments: --${field.flag} given more than once` }
      : {}),
    key: field.key,
    takesValue: value.length === 0,
  };
}

/**
 * @param rawArgs - Words after the command name.
 * @param options - Options the command takes.
 * @returns {{ errors: string[]; positionals: number }} Option failures and the positional count.
 */
function scanWords(
  rawArgs: readonly string[],
  options: OptionTable,
): { errors: string[]; positionals: number } {
  const errors: string[] = [];
  const seen: string[] = [];
  let positionals = 0;
  for (let index = 0; index < rawArgs.length; index++) {
    const word = rawArgs[index] ?? "";
    if (word === "--") return { errors, positionals: positionals + rawArgs.length - index - 1 };
    if (!word.startsWith("-") || word === "-") {
      positionals++;
      continue;
    }
    const scanned = scanOption(word, options, seen);
    if (scanned.error !== undefined) errors.push(scanned.error);
    if (scanned.key !== undefined) seen.push(scanned.key);
    if (scanned.takesValue) index++;
  }
  return { errors, positionals };
}

/**
 * Finds what citty would accept without a word: an undeclared option, which
 * citty takes as a boolean and so shifts the next word into the positionals,
 * a value option given twice, of which citty keeps the last, and a positional
 * argument the tool does not take.
 *
 * @param rawArgs - Words after the command name.
 * @param fields - The command's fields.
 * @returns {string[]} One failure per line, in the core's format.
 */
function commandLineErrors(rawArgs: readonly string[], fields: readonly Field[]): string[] {
  const { errors, positionals } = scanWords(rawArgs, optionTable(fields));
  // After an unknown option its value reads as a positional; the option is the failure to name.
  const extra = positionals - fields.filter((field) => field.positional).length;
  if (extra <= 0 || errors.length > 0) return errors;
  return [
    ...errors,
    `Invalid arguments: ${extra} unexpected positional argument${extra === 1 ? "" : "s"}`,
  ];
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
 * @param args - citty's parsed arguments.
 * @returns {unknown} The input object.
 * @throws {ToolInputError} When a JSON value does not parse.
 */
function toolInput(
  tool: ToolDefinition,
  fields: readonly Field[],
  args: Readonly<Record<string, unknown>>,
): unknown {
  const input: Record<string, unknown> = {};
  const errors: string[] = [];
  for (const field of fields) {
    const raw = args[field.flag];
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
  return (
    (JSON.stringify(
      details,
      (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value),
      2,
    ) as string | undefined) ?? "null"
  );
}

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

  return {
    meta: {
      name: commandName(tool),
      description: tool.cli?.description ?? summary,
      ...(tool.cli?.aliases ? { alias: [...tool.cli.aliases] } : {}),
    },
    args,
    async run(context: CommandContext) {
      try {
        const errors = commandLineErrors(context.rawArgs, fields);
        if (errors.length > 0) throw new ToolInputError(errors);
        const result = await invokeTool(tool, toolInput(tool, fields, context.args));
        if (result.isError === true) {
          writeLine("stderr", sanitizeText(resultText(result)));
          process.exitCode = 1;
        } else if (context.args["json"] === true) {
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
 * Builds the main command without loading citty.
 *
 * @param options - CLI options.
 * @returns {CommandDef} The main command.
 * @throws {ToolDefinitionError} When two commands share a name, or `default` or `fallback` names none.
 */
export function createCli(options: CliOptions): CommandDef {
  indexTools(options.tools);
  const names = options.tools.flatMap((tool) => [commandName(tool), ...(tool.cli?.aliases ?? [])]);
  const repeated = names.find((name, index) => names.indexOf(name) !== index);
  if (repeated !== undefined) throw new ToolDefinitionError(`Two commands are named ${repeated}`);

  const subCommands: SubCommandsDef = Object.fromEntries(
    options.tools.map((tool) => [commandName(tool), () => toolCommand(options, tool)]),
  );
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
    ...options.tools.flatMap((tool) => [commandName(tool), ...(tool.cli?.aliases ?? [])]),
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
  const resolved = await (typeof command === "function" ? command() : command);
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
 * loads, so colors are settled here first: only when both streams it writes to
 * are terminals that take them. `hasColors()` already honors `NO_COLOR` and
 * `TERM=dumb`.
 *
 * @param options - CLI options.
 * @param argv - Words after the executable and script.
 */
export async function runCli(
  options: CliOptions,
  argv: readonly string[] = process.argv.slice(2),
): Promise<void> {
  const { stderr, stdout } = process;
  if (!(stdout.isTTY && stdout.hasColors() && stderr.isTTY && stderr.hasColors())) {
    process.env["NO_COLOR"] = "1";
  }
  stdout.on("error", exitOnClosedPipe);
  stderr.on("error", exitOnClosedPipe);
  const main = createCli(options);
  const { runMain } = await import("citty");
  await runMain(main, { rawArgs: await normalizeArgv(options, argv) });
}
