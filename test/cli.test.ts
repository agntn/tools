import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { commandName, createCli, normalizeArgv, type CliOptions } from "../src/cli.ts";
import { defineTool, ToolDefinitionError, Type } from "../src/index.ts";
import { demoTools, DemoError, echo } from "./fixtures/demo.ts";

const options: CliOptions = {
  name: "demo",
  version: "1.2.3",
  description: "Demo tools",
  tools: demoTools,
  default: "measure",
  fallback: "echo",
  expected: (error) => error instanceof DemoError,
};

const fixture = fileURLToPath(new URL("fixtures/demo-cli.ts", import.meta.url));
const plainFixture = fileURLToPath(new URL("fixtures/plain-cli.ts", import.meta.url));

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

/**
 * Runs the CLI in process.
 *
 * @param argv - Words after the executable.
 * @param cli - CLI options.
 * @returns {Promise<{ stdout: string; stderr: string; exitCode: unknown }>} What it printed.
 */
async function run(argv: readonly string[], cli: CliOptions = options) {
  let stdout = "";
  let stderr = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr += String(chunk);
    return true;
  });
  await createCli(cli).run(argv);
  const exitCode = process.exitCode;
  process.exitCode = undefined;
  return { stdout, stderr, exitCode };
}

/**
 * Runs the fixture CLI as a process.
 *
 * @param argv - Words after the executable.
 * @param input - Bytes for stdin.
 * @returns {ReturnType<typeof spawnSync>} The finished process.
 */
function spawnCli(argv: readonly string[], input?: readonly number[]) {
  return spawnSync(process.execPath, [fixture, ...argv], {
    input: input && Uint8Array.from(input),
    encoding: "utf8",
  });
}

describe("CLI commands", () => {
  it("names a command after the tool without its package prefix, or after its hint", () => {
    expect(commandName(echo)).toBe("echo");
    expect(demoTools.map(commandName)).toEqual(["echo", "measure"]);
  });

  it("reads positionals, flags, integers and booleans into one validated call", async () => {
    expect(await run(["echo", "hi", "--mode", "loud", "--times=2", "--spaced"])).toEqual({
      stdout: "HI HI\n",
      stderr: "",
      exitCode: undefined,
    });
  });

  it("prints null for undefined details with --json", async () => {
    const bare = defineTool({ ...echo, execute: () => ({ content: [], details: undefined }) });
    expect(
      (await run(["echo", "hi", "--json"], { ...options, tools: [bare], default: undefined }))
        .stdout,
    ).toBe("null\n");
  });

  it("escapes what a terminal acts on in --json and keeps the details", async () => {
    const hostile = [0x85, 0x202e, 0x2028, 0x2066].map((point) => String.fromCodePoint(point));
    const details = { text: `a${hostile.join("b")}c` };
    const loud = defineTool({ ...echo, execute: () => ({ content: [], details }) });
    const { stdout } = await run(["echo", "hi", "--json"], {
      ...options,
      tools: [loud],
      default: undefined,
    });
    expect(hostile.some((character) => stdout.includes(character))).toBe(false);
    expect(stdout).toContain(String.raw`\u0085`);
    expect(JSON.parse(stdout)).toEqual(details);
  });

  it("prints details with --json", async () => {
    expect((await run(["echo", "hi", "--times", "2", "--json"])).stdout).toBe(
      `${JSON.stringify({ word: "hi", times: 2 }, null, 2)}\n`,
    );
  });

  it("applies the fallback, the default and the aliases", async () => {
    expect((await run(["hi"])).stdout).toBe("hi\n");
    expect(normalizeArgv(options, [])).toEqual(["measure"]);
    expect(normalizeArgv(options, ["--help"])).toEqual(["--help"]);
    expect(normalizeArgv(options, ["-"])).toEqual(["echo", "-"]);
    expect((await run(["len", "abc"])).stdout).toBe("3\n");
  });

  it("parses JSON for object properties and names a value that is not JSON", async () => {
    expect((await run(["measure", "ab", "--weights", '{"x":2}'])).stdout).toBe("4\n");
    expect(await run(["measure", "ab", "--weights", "{x"])).toEqual({
      stdout: "",
      stderr: "Invalid arguments at /weights: must be JSON\n",
      exitCode: 1,
    });
  });

  it("fails with the core's validation lines", async () => {
    expect(await run(["echo", "a.b", "--times", "9"])).toEqual({
      stdout: "",
      stderr: [
        'Invalid arguments at /word: must match pattern "^[a-z]+$"',
        "Invalid arguments at /times: must be <= 3",
        "",
      ].join("\n"),
      exitCode: 1,
    });
  });

  it("rejects an unknown option, a repeated one and an extra positional before calling the tool", async () => {
    const execute = vi.spyOn(echo, "execute");
    expect((await run(["echo", "hi", "--tims", "2"])).stderr).toBe(
      'Invalid arguments: unknown option "--tims"; takes --mode, --times, --spaced, --json\n',
    );
    expect((await run(["echo", "hi", "--times", "2", "--times", "3"])).stderr).toBe(
      "Invalid arguments: --times given more than once\n",
    );
    expect((await run(["echo", "hi", "there"])).stderr).toBe(
      "Invalid arguments: 1 unexpected positional argument\n",
    );
    expect((await run(["echo", "hi", "-times", "2"])).stderr).toBe(
      'Invalid arguments: unknown option "-times"; takes --mode, --times, --spaced, --json\n',
    );
    expect((await run(["echo", "hi", "--no-times", "2"])).stderr).toBe(
      'Invalid arguments: unknown option "--no-times"; takes --mode, --times, --spaced, --json\n',
    );
    expect((await run(["echo", "hi", "--times"])).stderr).toBe(
      "Invalid arguments: --times needs a value\n",
    );
    expect((await run(["echo", "hi", "--spaced=yes"])).stderr).toBe(
      "Invalid arguments: --spaced takes no value\n",
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it("takes only the declared kebab spelling of a property", async () => {
    const snake = defineTool({
      name: "demo_snake",
      title: "Snake",
      description: "x",
      effect: "read",
      input: Type.Object(
        { read_only: Type.Optional(Type.String()), maxItems: Type.Optional(Type.Integer()) },
        { additionalProperties: false },
      ),
      execute: (input) => ({
        content: [{ type: "text", text: JSON.stringify(input) }],
        details: null,
      }),
    });
    const cli: CliOptions = { ...options, tools: [snake], default: undefined, fallback: undefined };
    expect((await run(["snake", "--read-only", "x", "--max-items", "2"], cli)).stdout).toBe(
      '{"read_only":"x","maxItems":2}\n',
    );
    for (const word of ["--read_only", "--maxItems"]) {
      expect((await run(["snake", word, "x"], cli)).stderr).toBe(
        `Invalid arguments: unknown option "${word}"; takes --read-only, --max-items, --json\n`,
      );
    }
  });

  it("reads prototype names as plain properties", async () => {
    const proto = defineTool({
      name: "demo_proto",
      title: "Proto",
      description: "x",
      effect: "read",
      input: Type.Object(
        { toString: Type.Optional(Type.String()), constructor: Type.Optional(Type.String()) },
        { additionalProperties: false },
      ),
      execute: (input) => ({
        content: [{ type: "text", text: JSON.stringify(input) }],
        details: null,
      }),
    });
    const cli: CliOptions = { ...options, tools: [proto], default: undefined, fallback: undefined };
    expect(await run(["proto", "--constructor", "x"], cli)).toEqual({
      stdout: '{"constructor":"x"}\n',
      stderr: "",
      exitCode: undefined,
    });
  });

  it("lets stdin feed one argument only", async () => {
    const pair = defineTool({
      name: "demo_pair",
      title: "Pair",
      description: "x",
      effect: "read",
      input: Type.Object({ a: Type.String(), b: Type.String() }, { additionalProperties: false }),
      cli: { positional: ["a", "b"], stdin: ["a", "b"] },
      execute: () => ({ content: [], details: null }),
    });
    const cli: CliOptions = { ...options, tools: [pair], default: undefined, fallback: undefined };
    expect(await run(["pair", "-", "-"], cli)).toEqual({
      stdout: "",
      stderr: "Invalid arguments: stdin can feed one argument, not a and b\n",
      exitCode: 1,
    });
  });

  it("prints a returned failure on stderr with exit code 1", async () => {
    expect(await run(["echo", "fail"])).toEqual({
      stdout: "",
      stderr: "cannot echo fail\n",
      exitCode: 1,
    });
  });

  it("prints an expected error as one line and lets any other error through", async () => {
    expect(await run(["echo", "known"])).toEqual({
      stdout: "",
      stderr: "known failure\n",
      exitCode: 1,
    });
    await expect(run(["echo", "boom"])).rejects.toThrow("exploded");
  });

  it("strips escape sequences, C1 and bidi controls from the text but keeps its layout", async () => {
    expect((await run(["echo", "escape"])).stdout).toBe(
      `aredb\nnext line\t${String.fromCodePoint(0x1f469, 0x200d, 0x1f4bb)}\n`,
    );
  });

  it("puts the package's commands next to the generated ones and guards them", async () => {
    const ownEcho = defineTool({
      name: "demo_own_echo",
      title: "Own echo",
      description: "Echo it my way.",
      effect: "read",
      input: Type.Object({ word: Type.String() }, { additionalProperties: false }),
      cli: { command: "echo", positional: ["word"] },
      execute: ({ word }) => ({ content: [{ type: "text", text: `own ${word}` }], details: null }),
    });
    const info = defineTool({
      name: "demo_info",
      title: "Info",
      description: "Tell about it.",
      effect: "read",
      input: Type.Object({}),
      cli: { aliases: ["i"] },
      execute() {
        throw new DemoError("no info");
      },
    });
    const cli: CliOptions = { ...options, commands: [ownEcho, info] };
    expect((await run(["echo", "hi"], cli)).stdout).toBe("own hi\n");
    expect(await run(["info"], cli)).toEqual({ stdout: "", stderr: "no info\n", exitCode: 1 });
    expect((await run(["i"], cli)).stderr).toBe("no info\n");
    // The alias of a replaced tool command goes with it, to the fallback.
    const replaced: CliOptions = {
      ...options,
      commands: [{ ...info, cli: { command: "measure" } }],
    };
    expect(normalizeArgv(replaced, ["len"])).toEqual(["echo", "len"]);
  });
});

describe("CLI definitions", () => {
  const tool = (cli: NonNullable<Parameters<typeof defineTool>[0]["cli"]>, json = false) =>
    defineTool({
      name: "demo_bad",
      title: "Bad",
      description: "x",
      effect: "read",
      input: Type.Object(
        json ? { json: Type.String() } : { flag: Type.Boolean(), text: Type.Integer() },
        { additionalProperties: false },
      ),
      cli,
      execute: () => ({ content: [], details: null }),
    });
  const build = async (bad: ReturnType<typeof tool>) =>
    run(["bad"], { ...options, tools: [bad], default: undefined, fallback: undefined });

  it("rejects hints the schema cannot take", async () => {
    await expect(build(tool({ positional: ["nope"] }))).rejects.toThrow(ToolDefinitionError);
    await expect(build(tool({ positional: ["flag"] }))).rejects.toThrow(/cannot be positional/);
    await expect(build(tool({ positional: ["text", "text"] }))).rejects.toThrow(
      /lists positional text twice/,
    );
    await expect(build(tool({ stdin: ["text"] }))).rejects.toThrow(/must be a string/);
    await expect(build(tool({}, true))).rejects.toThrow(/reserved flag --json/);
    for (const word of ["--foo", "-x", "", "two words"]) {
      await expect(build(tool({ command: word }))).rejects.toThrow(/must match/);
      expect(() =>
        createCli({ ...options, tools: [tool({ command: "ok", aliases: [word] })] }),
      ).toThrow(/must match/);
    }
  });

  it("rejects two options read under one spelling", () => {
    const clash = defineTool({
      name: "demo_clash",
      title: "Clash",
      description: "x",
      effect: "read",
      input: Type.Object(
        { cache: Type.Optional(Type.Boolean()), noCache: Type.Optional(Type.String()) },
        { additionalProperties: false },
      ),
      execute: () => ({ content: [], details: null }),
    });
    expect(() =>
      createCli({ ...options, tools: [clash], default: undefined, fallback: undefined }),
    ).toThrow("demo_clash: properties cache and noCache both answer to --no-cache");
  });

  it("rejects a flag no word can spell and an optional positional before a required one", () => {
    const make = (
      properties: Readonly<Record<string, boolean>>,
      positional: readonly string[] = [],
    ) =>
      defineTool({
        name: "demo_shape",
        title: "Shape",
        description: "x",
        effect: "read",
        input: Type.Object(
          Object.fromEntries(
            Object.entries(properties).map(([key, required]) => [
              key,
              required ? Type.String() : Type.Optional(Type.String()),
            ]),
          ),
          { additionalProperties: false },
        ),
        cli: { positional },
        execute: () => ({ content: [], details: null }),
      });
    const build = (tool: ReturnType<typeof make>) => () =>
      createCli({ ...options, tools: [tool], default: undefined, fallback: undefined });
    for (const key of ["", "a=b", "-x", "a b"]) {
      expect(build(make({ [key]: true }))).toThrow(/must match/);
    }
    expect(build(make({ first: false, second: true }, ["first", "second"]))).toThrow(
      "demo_shape: required positional second comes after an optional one",
    );
    expect(build(make({ first: false, second: true }, ["second", "first"]))).not.toThrow();
  });

  it("rejects a boolean flag starting with no-", () => {
    const negative = defineTool({
      name: "demo_negative",
      title: "Negative",
      description: "x",
      effect: "read",
      input: Type.Object(
        { noCache: Type.Optional(Type.Boolean()) },
        { additionalProperties: false },
      ),
      execute: () => ({ content: [], details: null }),
    });
    expect(() =>
      createCli({ ...options, tools: [negative], default: undefined, fallback: undefined }),
    ).toThrow(/boolean property noCache cannot take a flag starting with no-/);
  });

  it("takes -h only as a whole word and sanitizes --version", async () => {
    expect((await run(["echo", "hi", "-xh"])).stderr).toBe(
      'Invalid arguments: unknown option "-xh"; takes --mode, --times, --spaced, --json\n',
    );
    const forged = `1.0${String.fromCodePoint(10)}FAKE${String.fromCodePoint(0x1b)}[31m`;
    expect((await run(["--version"], { ...options, version: forged })).stdout).toBe("1.0 FAKE\n");
  });

  it("takes a positional whose key is no option name", async () => {
    const json = defineTool({
      name: "demo_json",
      title: "Json",
      description: "x",
      effect: "read",
      input: Type.Object({ json: Type.String() }, { additionalProperties: false }),
      cli: { positional: ["json"] },
      execute: ({ json: text }) => ({ content: [{ type: "text", text }], details: null }),
    });
    const cli: CliOptions = { ...options, tools: [json], default: undefined, fallback: undefined };
    expect((await run(["json", "{}"], cli)).stdout).toBe("{}\n");
  });

  it("gives mcp no --json", async () => {
    const cli: CliOptions = { ...options, mcp: true };
    expect((await run(["mcp", "--json"], cli)).stderr).toBe(
      'Invalid arguments: unknown option "--json"; takes no options\n',
    );
    const { stdout } = await run(["mcp", "--help"], cli);
    expect(stdout).not.toContain("--json");
    expect(stdout).toContain("USAGE demo mcp\n");
  });

  it("sanitizes the usage text", async () => {
    const loud = defineTool({
      ...echo,
      description: `Echo${String.fromCodePoint(0x1b)}[31m red${String.fromCodePoint(0x202e)}x.`,
    });
    const { stdout } = await run(["--help"], { ...options, tools: [loud], default: undefined });
    expect(stdout).toContain("Echo redx.");
    expect([0x1b, 0x202e].some((point) => stdout.includes(String.fromCodePoint(point)))).toBe(
      false,
    );
  });

  it("rejects a derived command name that cannot be dispatched", () => {
    for (const name of ["demo__h", "demo_"]) {
      expect(() => commandName({ ...echo, name })).toThrow(/must match/);
    }
  });

  it("rejects two commands of one name and a default that names none", () => {
    expect(() => createCli({ ...options, tools: [echo, tool({ command: "echo" })] })).toThrow(
      /Two commands are named echo/,
    );
    expect(() => createCli({ ...options, default: "nope" })).toThrow(/no command nope/);
    // `measure` is replaced, so its alias `len` is free for a tool command.
    const len = tool({ command: "len" });
    expect(() =>
      createCli({
        ...options,
        tools: [...demoTools, len],
        commands: [{ ...echo, name: "demo_own_measure", cli: { command: "measure" } }],
      }),
    ).not.toThrow();
  });
});

describe("CLI process", () => {
  it("reads stdin as UTF-8 for a stdin property", () => {
    const answer = spawnCli(["measure", "-"], [...new TextEncoder().encode("zażółć")]);
    expect([answer.stdout, answer.status]).toEqual(["6\n", 0]);
  });

  it("refuses stdin that is not UTF-8 instead of hashing replacement characters", () => {
    const answer = spawnCli(["measure", "-"], [0xff, 0xfe, 0x41]);
    expect([answer.stdout, answer.stderr, answer.status]).toEqual([
      "",
      "Invalid arguments at /text: stdin is not UTF-8 text\n",
      1,
    ]);
  });

  it("prints usage and errors without colors into a pipe", () => {
    const help = spawnCli(["--help"]);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("measure, len");
    expect(help.stdout).not.toContain("\u001B[");
    const bad = spawnCli(["echo", "hi", "--mode", "x"]);
    expect(bad.status).toBe(1);
    expect(bad.stderr).toBe("Invalid arguments at /mode: must be one of plain, loud\n");
    expect(bad.stderr).not.toContain("\u001B[");
  });

  it("writes no escape sequences in usage or errors", () => {
    const env: NodeJS.ProcessEnv = { ...process.env, TERM: "xterm-256color", FORCE_COLOR: "1" };
    for (const argv of [["--help"], ["echo", "--help"], ["nope"], []]) {
      const answer = spawnSync(process.execPath, [plainFixture, ...argv], {
        env,
        encoding: "utf8",
      });
      expect(`${answer.stdout}${answer.stderr}`).not.toContain(String.fromCodePoint(0x1b));
    }
  });

  it("keeps a forged command word on one line", () => {
    const word = `bad${String.fromCodePoint(10)}forged${String.fromCodePoint(0x202e)}x`;
    const answer = spawnSync(process.execPath, [plainFixture, word], { encoding: "utf8" });
    expect(answer.status).toBe(1);
    expect(answer.stderr).toBe(
      `Unknown command ${JSON.stringify(word).replace(String.fromCodePoint(0x202e), " ")}\nRun demo --help for the commands\n`,
    );
  });

  it("leaves --help after -- to the tool and still answers --help and --version", () => {
    const literal = spawnSync(process.execPath, [plainFixture, "measure", "--", "--help"], {
      encoding: "utf8",
    });
    expect([literal.stdout, literal.status]).toEqual(["6\n", 0]);
    const help = spawnSync(process.execPath, [plainFixture, "echo", "hi", "--help"], {
      encoding: "utf8",
    });
    expect([help.stdout.includes("USAGE demo echo"), help.status]).toEqual([true, 0]);
    const version = spawnSync(process.execPath, [plainFixture, "--version"], { encoding: "utf8" });
    expect(version.stdout).toBe("1.2.3\n");
  });

  it("serves the same tools over MCP with the mcp command", async () => {
    const client = new Client({ name: "test", version: "0" });
    await client.connect(
      new StdioClientTransport({ command: process.execPath, args: [fixture, "mcp"] }),
    );
    try {
      expect((await client.listTools()).tools.map((each) => each.name)).toEqual([
        "demo_echo",
        "demo_text_measure",
      ]);
      expect(
        await client.callTool({ name: "demo_echo", arguments: { word: "hi", mode: "loud" } }),
      ).toMatchObject({ content: [{ text: "HI" }] });
    } finally {
      await client.close();
    }
  });
});
