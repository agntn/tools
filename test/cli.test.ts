import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  commandName,
  createCli,
  normalizeArgv,
  type CliHost,
  type CliOptions,
} from "../src/cli.ts";
import {
  defineTool,
  invokeTool,
  ToolDefinitionError,
  Type,
  type ToolDefinition,
  type TSchema,
} from "../src/index.ts";
import { demoTools, DemoError, echo, serverInfo } from "./fixtures/demo.ts";

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
const serverInfoFixture = fileURLToPath(new URL("fixtures/server-info-cli.ts", import.meta.url));

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
      stderr: "Invalid arguments at --weights: must be JSON\n",
      exitCode: 1,
    });
    for (const weight of ["1.5", '"2"']) {
      expect(await run(["measure", "ab", "--weights", `{"x":${weight}}`])).toEqual({
        stdout: "",
        stderr: "Invalid arguments at /x of --weights: must be integer\n",
        exitCode: 1,
      });
    }
  });

  it("reads number words as decimals and refuses whatever TypeBox would bend", async () => {
    const scale = defineTool({
      name: "demo_scale",
      title: "Scale",
      description: "Scale a count.",
      effect: "read",
      input: Type.Object(
        { count: Type.Integer(), factor: Type.Optional(Type.Number()) },
        { additionalProperties: false },
      ),
      execute: (input) => ({
        content: [{ type: "text", text: JSON.stringify(input) }],
        details: null,
      }),
    });
    const cli = { ...options, tools: [scale], default: undefined, fallback: undefined };
    const scaled = async (count: string, factor = "1") =>
      run(["scale", `--count=${count}`, `--factor=${factor}`], cli);

    expect((await scaled("-5", "1e3")).stdout).toBe('{"count":-5,"factor":1000}\n');
    expect((await scaled("+007", "-.5")).stdout).toBe('{"count":7,"factor":-0.5}\n');
    expect((await scaled("2", "2.")).stdout).toBe('{"count":2,"factor":2}\n');
    for (const count of [
      "1.5",
      "2.9",
      "0x10",
      "0b11",
      "1e3",
      "3.0",
      "",
      " 2",
      "1_000",
      "9".repeat(400),
    ]) {
      expect(await scaled(count)).toEqual({
        stdout: "",
        stderr: "Invalid arguments at --count: must be integer\n",
        exitCode: 1,
      });
    }
    for (const factor of [
      "0x10",
      "0o7",
      "",
      " ",
      "Infinity",
      "NaN",
      "1e400",
      "1_0",
      ".",
      `${"9".repeat(200_000)}x`,
    ]) {
      expect(await scaled("1", factor)).toEqual({
        stdout: "",
        stderr: "Invalid arguments at --factor: must be number\n",
        exitCode: 1,
      });
    }
  });

  it("reads a word for a union the way some branch takes it", async () => {
    const pick = defineTool({
      name: "demo_pick",
      title: "Pick",
      description: "Pick a limit.",
      effect: "read",
      input: Type.Object(
        {
          limit: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
          label: Type.Optional(Type.Union([Type.Integer(), Type.String()])),
          size: Type.Optional(Type.Union([Type.Enum(["all"]), Type.Integer()])),
          strict: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
          cursor: Type.Optional(Type.Null()),
          level: Type.Optional(Type.Enum([1, 2])),
          depth: Type.Optional(
            Type.Union([Type.Union([Type.Integer(), Type.Null()]), Type.Boolean()]),
          ),
          page: Type.Optional(Type.Unsafe<number | null>({ type: ["integer", "null"] })),
          step: Type.Optional(
            Type.Unsafe<number | boolean>({ oneOf: [{ type: "number" }, { type: "boolean" }] }),
          ),
          floor: Type.Optional(Type.Intersect([Type.Integer(), Type.Number({ minimum: 1 })])),
          code: Type.Optional(Type.Union([Type.String({ pattern: "^[a-z]+$" }), Type.Integer()])),
        },
        { additionalProperties: false },
      ),
      execute: (input) => ({
        content: [{ type: "text", text: JSON.stringify(input) }],
        details: null,
      }),
    });
    const cli = { ...options, tools: [pick], default: undefined, fallback: undefined };
    const picked = async (...argv: readonly string[]) => run(["pick", ...argv], cli);

    expect((await picked("--limit", "2", "--label", "2", "--size", "3")).stdout).toBe(
      '{"limit":2,"label":"2","size":3}\n',
    );
    expect(
      (await picked("--limit", "null", "--size", "all", "--strict", "false", "--cursor", "null"))
        .stdout,
    ).toBe('{"limit":null,"size":"all","strict":false,"cursor":null}\n');
    expect(
      (await picked("--level", "2", "--depth", "2", "--page", "3", "--step", "0.5")).stdout,
    ).toBe('{"level":2,"depth":2,"page":3,"step":0.5}\n');
    expect((await picked("--floor", "2", "--code", "2")).stdout).toBe('{"floor":2,"code":2}\n');
    expect((await picked("--code", "ab")).stdout).toBe('{"code":"ab"}\n');
    expect((await picked("--level", "2.0")).stderr).toBe(
      "Invalid arguments at --level: must be one of 1, 2\n",
    );
    for (const limit of ["1.5", "0x10"]) {
      const { stdout, stderr } = await picked("--limit", limit);
      expect(stdout).toBe("");
      expect(stderr).toContain("Invalid arguments at --limit: must be integer\n");
    }
  });

  it("fails with the core's validation lines, placed by the words of the line", async () => {
    expect(await run(["echo", "a.b", "--times", "9"])).toEqual({
      stdout: "",
      stderr: [
        'Invalid arguments at <WORD>: must match pattern "^[a-z]+$"',
        "Invalid arguments at --times: must be <= 3",
        "",
      ].join("\n"),
      exitCode: 1,
    });
  });

  describe("schema failures in the words of the line", () => {
    const point = Type.Object(
      { x: Type.Number(), y: Type.Number() },
      { additionalProperties: false },
    );
    const plot = defineTool({
      name: "demo_plot",
      title: "Plot",
      description: "Plots a point.",
      effect: "read",
      input: Type.Object(
        { label: Type.String(), point, limit: Type.Optional(Type.Integer({ minimum: 1 })) },
        { additionalProperties: false },
      ),
      cli: { positional: ["label"] },
      execute: (input) => ({ content: [], details: input }),
    });
    const cli: CliOptions = { ...options, tools: [plot], default: undefined, fallback: undefined };

    it("names a missing positional as the usage does and a missing flag by its spelling", async () => {
      expect(await run(["plot"], cli)).toEqual({
        stdout: "",
        stderr: "Invalid arguments: missing <LABEL>\nInvalid arguments: missing --point\n",
        exitCode: 1,
      });
      expect((await run(["plot", "--help"], cli)).stdout).toContain(
        "USAGE demo plot [OPTIONS] <LABEL>\n",
      );
    });

    it("names the flag whose bound broke and the flag whose JSON did", async () => {
      expect(
        (await run(["plot", "a", "--point", '{"x":1,"y":2,"z":3}', "--limit", "0"], cli)).stderr,
      ).toBe(
        [
          'Invalid arguments at --point: unknown property "z"; takes x, y',
          "Invalid arguments at --limit: must be >= 1",
          "",
        ].join("\n"),
      );
      expect((await run(["plot", "a", "--point", '{"x":1}'], cli)).stderr).toBe(
        "Invalid arguments at --point: must have required properties y\n",
      );
      expect((await run(["plot", "a", "--point", '{"x":1,"y":"2"}'], cli)).stderr).toBe(
        "Invalid arguments at /y of --point: must be number\n",
      );
    });

    it("leaves a failure the executor throws from another tool as that tool said it", async () => {
      const relay = defineTool({
        name: "demo_relay",
        title: "Relay",
        description: "Plots through another tool.",
        effect: "read",
        input: Type.Object({ limit: Type.Integer() }, { additionalProperties: false }),
        execute: async ({ limit }) =>
          await invokeTool(plot, { label: "a", point: { x: 0, y: 0 }, limit }),
      });
      const relayed: CliOptions = { ...cli, tools: [relay] };
      expect((await run(["relay", "--limit", "0"], relayed)).stderr).toBe(
        "Invalid arguments at /limit: must be >= 1\n",
      );
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
      stderr: "Invalid arguments: stdin can feed one argument, not <A> and <B>\n",
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

  it("prints nothing for no content blocks but a line for an empty text", async () => {
    const quiet = defineTool({
      name: "demo_quiet",
      title: "Quiet",
      description: "Say nothing, or an empty line.",
      effect: "read",
      input: Type.Object({ line: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
      execute: ({ line }) => ({
        content: line === true ? [{ type: "text", text: "" }] : [],
        details: { line: line === true },
      }),
    });
    const cli: CliOptions = { ...options, commands: [quiet] };
    expect(await run(["quiet"], cli)).toEqual({ stdout: "", stderr: "", exitCode: undefined });
    expect((await run(["quiet", "--line"], cli)).stdout).toBe("\n");
    expect((await run(["quiet", "--json"], cli)).stdout).toBe('{\n  "line": false\n}\n');
  });

  it("tells a command whether --json asked for the details", async () => {
    const rows = defineTool({
      name: "demo_rows",
      title: "Rows",
      description: "Stream rows, or answer them as details.",
      effect: "read",
      input: Type.Object({ raw: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
      execute({ raw }, { host }) {
        const json = (host as CliHost | undefined)?.json === true;
        if (raw === true && json) {
          return {
            content: [{ type: "text", text: "--raw writes bytes, --json can't follow" }],
            details: null,
            isError: true,
          };
        }
        if (json) return { content: [], details: { rows: ["a", "b"] } };
        process.stdout.write("a\nb\n");
        return { content: [], details: null };
      },
    });
    const cli: CliOptions = { ...options, commands: [rows] };
    expect((await run(["rows"], cli)).stdout).toBe("a\nb\n");
    expect((await run(["rows", "--json"], cli)).stdout).toBe(
      '{\n  "rows": [\n    "a",\n    "b"\n  ]\n}\n',
    );
    expect(await run(["rows", "--raw", "--json"], cli)).toEqual({
      stdout: "",
      stderr: "--raw writes bytes, --json can't follow\n",
      exitCode: 1,
    });
  });

  it("hands a generated command the same host and a call off the CLI none", async () => {
    const seen: unknown[] = [];
    const peek = defineTool({
      name: "demo_peek",
      title: "Peek",
      description: "Look at the host.",
      effect: "read",
      input: Type.Object({}),
      execute(_input, { host }) {
        seen.push(host);
        return { content: [], details: null };
      },
    });
    await run(["peek"], { ...options, tools: [...demoTools, peek] });
    await run(["peek", "--json"], { ...options, tools: [...demoTools, peek] });
    await invokeTool(peek, {});
    expect(seen).toEqual([{ cli: true, json: false }, { cli: true, json: true }, undefined]);
  });
});

/* Runs the CLI with stderr on a terminal `columns` wide, or off one. */
async function runOnTerminal(tty: boolean, argv: readonly string[], cli: CliOptions, columns = 80) {
  const before = { isTTY: process.stderr.isTTY, columns: process.stderr.columns };
  Object.assign(process.stderr, { isTTY: tty, columns });
  try {
    return await run(argv, cli);
  } finally {
    Object.assign(process.stderr, before);
  }
}

describe("CLI progress", () => {
  const slow = defineTool({
    name: "demo_slow",
    title: "Slow",
    description: "Take a while, say so, and fail on request.",
    effect: "read",
    input: Type.Object({ fail: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
    execute({ fail }, { progress }) {
      progress?.("Hashing block 1", { progress: 1, total: 2 });
      progress?.("Nearly\u001B[2J\nthere");
      if (fail === true) throw new DemoError("disk on fire");
      return { content: [{ type: "text", text: "done" }], details: null };
    },
  });
  const cli: CliOptions = { ...options, tools: [...demoTools, slow] };

  it("rewrites one stderr line on a terminal and wipes it before the answer", async () => {
    expect(await runOnTerminal(true, ["slow"], cli)).toEqual({
      stdout: "done\n",
      stderr: `Hashing block 1 (1/2)\r${" ".repeat(21)}\rNearly there\r${" ".repeat(12)}\r`,
      exitCode: undefined,
    });
  });

  it("wipes the line before an error and cuts it to the terminal width", async () => {
    expect(await runOnTerminal(true, ["slow", "--fail"], cli, 8)).toEqual({
      stdout: "",
      stderr: `Hashing\r${" ".repeat(7)}\rNearly \r${" ".repeat(7)}\rdisk on fire\n`,
      exitCode: 1,
    });
  });

  it("counts the cells wide characters and emoji take, and an empty line clears", async () => {
    const wide = defineTool({
      name: "demo_wide",
      title: "Wide",
      description: "Report progress in wide characters.",
      effect: "read",
      input: Type.Object({}),
      execute(_input, { progress }) {
        progress?.("日本語のテキスト");
        progress?.("👍🏽 ok");
        progress?.("1\uFE0F\u20E32\uFE0F\u20E33\uFE0F\u20E34\uFE0F\u20E3");
        progress?.("");
        return { content: [{ type: "text", text: "done" }], details: null };
      },
    });
    expect(
      await runOnTerminal(true, ["wide"], { ...options, tools: [...demoTools, wide] }, 8),
    ).toEqual({
      stdout: "done\n",
      stderr: `日本語\r${" ".repeat(6)}\r👍🏽 ok\r${" ".repeat(7)}\r1\uFE0F\u20E32\uFE0F\u20E33\uFE0F\u20E3\r${" ".repeat(6)}\r`,
      exitCode: undefined,
    });
  });

  it("keeps a pipe to the answer alone", async () => {
    expect(await runOnTerminal(false, ["slow"], cli)).toEqual({
      stdout: "done\n",
      stderr: "",
      exitCode: undefined,
    });
  });
});

describe("CLI short flags and rest", () => {
  const find = (cli: NonNullable<Parameters<typeof defineTool>[0]["cli"]>) =>
    defineTool({
      name: "demo_find",
      title: "Find",
      description: "Find a place.",
      effect: "read",
      input: Type.Object(
        {
          query: Type.String({ description: "Place to find" }),
          provider: Type.Optional(Type.String()),
          limit: Type.Optional(Type.Integer()),
          exact: Type.Optional(Type.Boolean()),
        },
        { additionalProperties: false },
      ),
      cli,
      execute: (input) => ({
        content: [{ type: "text", text: JSON.stringify(input) }],
        details: null,
      }),
    });
  const hints = { rest: "query", short: { provider: "p", limit: "n", exact: "x" } };
  const cli = (tool: ToolDefinition = find(hints)): CliOptions => ({
    ...options,
    tools: [tool],
    default: undefined,
    fallback: undefined,
  });
  const takes = "takes --provider (-p), --limit (-n), --exact (-x), --json";

  it("joins the words left into the rest property and reads short flags anywhere", async () => {
    expect(
      await run(["find", "52", "13", "46.9", "N", "-p", "osm", "-n", "2", "-x"], cli()),
    ).toEqual({
      stdout: '{"query":"52 13 46.9 N","provider":"osm","limit":2,"exact":true}\n',
      stderr: "",
      exitCode: undefined,
    });
    expect(
      (await run(["find", "-n", "1", "Warsaw", "--no-exact", "Old", "Town"], cli())).stdout,
    ).toBe('{"query":"Warsaw Old Town","limit":1,"exact":false}\n');
    expect((await run(["find", "--", "-12", "5"], cli())).stdout).toBe('{"query":"-12 5"}\n');
  });

  it("takes a short flag only as a whole word", async () => {
    const tool = find(hints);
    const execute = vi.spyOn(tool, "execute");
    for (const word of ["-pfoo", "-xn", "-provider", "-p=osm"]) {
      expect((await run(["find", word, "Warsaw"], cli(tool))).stderr).toBe(
        `Invalid arguments: unknown option ${JSON.stringify(word)}; ${takes}\n`,
      );
    }
    expect((await run(["find", "Warsaw", "-p", "a", "--provider", "b"], cli(tool))).stderr).toBe(
      "Invalid arguments: --provider given more than once\n",
    );
    expect((await run(["find", "Warsaw", "-p"], cli(tool))).stderr).toBe(
      "Invalid arguments: --provider needs a value\n",
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it("leaves a required rest to the core when no word is left", async () => {
    const { stderr, exitCode } = await run(["find", "-n", "1"], cli());
    expect(stderr).toBe("Invalid arguments: missing <QUERY...>\n");
    expect(exitCode).toBe(1);
  });

  it("shows the short flags and the rest in the usage", async () => {
    const { stdout } = await run(["find", "--help"], cli());
    expect(stdout).toContain("USAGE demo find [OPTIONS] <QUERY...>\n");
    expect(stdout).toContain("  -p, --provider=<provider>");
    expect(stdout).toContain("  -x, --[no-]exact");
  });

  it("joins the rest into a string enum and lets the core check it", async () => {
    const city = defineTool({
      name: "demo_city",
      title: "City",
      description: "x",
      effect: "read",
      input: Type.Object(
        { name: Type.Enum(["New York", "Los Angeles"]) },
        { additionalProperties: false },
      ),
      cli: { rest: "name" },
      execute: ({ name }) => ({ content: [{ type: "text", text: name }], details: null }),
    });
    expect((await run(["city", "New", "York"], cli(city))).stdout).toBe("New York\n");
    expect((await run(["city", "Paris"], cli(city))).exitCode).toBe(1);
  });

  describe("on an array", () => {
    const search = (words: TSchema, required = false) =>
      defineTool({
        name: "demo_search",
        title: "Search",
        description: "Search for words.",
        effect: "read",
        input: Type.Object(
          {
            digest: Type.String(),
            words: required ? words : Type.Optional(words),
            limit: Type.Optional(Type.Integer()),
          },
          { additionalProperties: false },
        ),
        cli: { positional: ["digest"], rest: "words" },
        execute: (input) => ({
          content: [{ type: "text", text: JSON.stringify(input) }],
          details: null,
        }),
      });
    const strings = search(Type.Array(Type.String(), { minItems: 1 }));

    it("keeps one item per word, a space inside a word included", async () => {
      expect(
        (await run(["search", "ab12", "jacque fresco", "--limit", "3", "venus"], cli(strings)))
          .stdout,
      ).toBe('{"digest":"ab12","words":["jacque fresco","venus"],"limit":3}\n');
      expect((await run(["search", "ab12", "--", "-12", "", "--limit"], cli(strings))).stdout).toBe(
        '{"digest":"ab12","words":["-12","","--limit"]}\n',
      );
    });

    it("leaves an optional array out when no word is left", async () => {
      expect((await run(["search", "ab12"], cli(strings))).stdout).toBe('{"digest":"ab12"}\n');
      expect((await run(["search", "--help"], cli(strings))).stdout).toContain(
        "USAGE demo search [OPTIONS] <DIGEST> [WORDS...]\n",
      );
    });

    it("gives a required array no words as an empty one and lets the core judge it", async () => {
      const any = search(Type.Array(Type.String()), true);
      expect((await run(["search", "ab12"], cli(any))).stdout).toBe(
        '{"digest":"ab12","words":[]}\n',
      );
      const some = search(Type.Array(Type.String(), { minItems: 1 }), true);
      expect((await run(["search", "ab12"], cli(some))).stderr).toContain(
        "Invalid arguments at <WORDS...>: must not have fewer than 1 items\n",
      );
    });

    it("reads each word against the item schema and lets the core check the rest", async () => {
      const colors = search(Type.Array(Type.Enum(["red", "green"]), { maxItems: 2 }));
      expect((await run(["search", "ab12", "red", "green"], cli(colors))).stdout).toBe(
        '{"digest":"ab12","words":["red","green"]}\n',
      );
      expect((await run(["search", "ab12", "red", "blue"], cli(colors))).stderr).toContain(
        "Invalid arguments at word 2 of [WORDS...]: must be one of red, green",
      );
      expect((await run(["search", "ab12", "red", "red", "red"], cli(colors))).stderr).toContain(
        "Invalid arguments at [WORDS...]: must not have more than 2 items\n",
      );
    });

    it("refuses an array whose items are no text", () => {
      expect(() => createCli(cli(search(Type.Array(Type.Integer()))))).toThrow(
        "demo_search: rest property words must be a string or an array of strings",
      );
      expect(() => createCli(cli(search(Type.Array(Type.Array(Type.String())))))).toThrow(
        "demo_search: rest property words must be a string or an array of strings",
      );
      expect(() =>
        createCli(cli(search(Type.Array(Type.Union([Type.Integer(), Type.Null()]))))),
      ).toThrow("demo_search: rest property words must be a string or an array of strings");
      expect(() =>
        createCli(
          cli(
            search(
              Type.Array(Type.Union([Type.String({ maxLength: 3 }), Type.Enum(["long word"])])),
            ),
          ),
        ),
      ).not.toThrow();
    });
  });

  it("rejects short and rest hints the schema cannot take", () => {
    const build = (hint: Parameters<typeof find>[0]) => () => createCli(cli(find(hint)));
    expect(build({ rest: "limit" })).toThrow(
      "demo_find: rest property limit must be a string or an array of strings",
    );
    expect(build({ rest: "nope" })).toThrow("demo_find: cli hint names unknown property nope");
    expect(build({ positional: ["query"], rest: "query" })).toThrow(
      "demo_find: cli hint lists positional query twice",
    );
    expect(build({ positional: ["provider"], rest: "query" })).toThrow(
      "demo_find: required positional query comes after an optional one",
    );
    expect(build({ short: { nope: "z" } })).toThrow(
      "demo_find: cli hint names unknown property nope",
    );
    expect(build({ rest: "query", short: { query: "q" } })).toThrow(
      "demo_find: positional property query takes no short flag",
    );
    for (const letter of ["", "pp", "1", "-", "é"]) {
      expect(build({ short: { provider: letter } })).toThrow(/must match/);
    }
    expect(build({ short: { provider: "h" } })).toThrow(
      "demo_find: property provider takes -h, which asks for help",
    );
    expect(build({ short: { provider: "p", limit: "p" } })).toThrow(
      "demo_find: properties provider and limit both answer to -p",
    );
  });
});

describe("CLI dashed text", () => {
  const decode = defineTool({
    name: "demo_decode",
    title: "Decode",
    description: "Decode a text.",
    effect: "read",
    input: Type.Object(
      {
        cipher: Type.String(),
        text: Type.Optional(Type.String()),
        key: Type.Optional(Type.String()),
        strict: Type.Optional(Type.Boolean()),
      },
      { additionalProperties: false },
    ),
    cli: { positional: ["cipher", "text"], short: { key: "k" } },
    execute: (input) => ({
      content: [{ type: "text", text: JSON.stringify(input) }],
      details: null,
    }),
  });
  const cli: CliOptions = { ...options, tools: [decode], default: undefined, fallback: undefined };
  const takes = "takes --key (-k), --strict, --json";

  it("reads a dashed word that spells no option as the next free positional", async () => {
    expect(await run(["decode", "morse", "-.-. .- -"], cli)).toEqual({
      stdout: `{"cipher":"morse","text":"-.-. .- -"}\n`,
      stderr: "",
      exitCode: undefined,
    });
    expect((await run(["decode", "-----BEGIN PGP MESSAGE-----", "--strict"], cli)).stdout).toBe(
      `{"cipher":"-----BEGIN PGP MESSAGE-----","strict":true}\n`,
    );
    expect((await run(["decode", "pgp", "-k", "-5", "--", "-k"], cli)).stdout).toBe(
      `{"cipher":"pgp","text":"-k","key":"-5"}\n`,
    );
    expect((await run(["decode", "-.-.", "-k", "x", "morse", "--no-strict"], cli)).stdout).toBe(
      `{"cipher":"-.-.","text":"morse","key":"x","strict":false}\n`,
    );
  });

  it("keeps refusing a dashed word once the plain words fill the positionals", async () => {
    const execute = vi.spyOn(decode, "execute");
    expect((await run(["decode", "morse", "hi", "-.-."], cli)).stderr).toBe(
      `Invalid arguments: unknown option "-.-."; ${takes}\n`,
    );
    expect((await run(["decode", "morse", "--kye", "x"], cli)).stderr).toBe(
      `Invalid arguments: unknown option "--kye"; ${takes}\n`,
    );
    expect((await run(["decode", "morse", "-.-.", "--kye", "x", "--strict"], cli)).stderr).toBe(
      [
        `Invalid arguments: unknown option "-.-."; ${takes}`,
        `Invalid arguments: unknown option "--kye"; ${takes}`,
        "",
      ].join("\n"),
    );
    expect((await run(["decode", "morse", "-.-.", "--", "x"], cli)).stderr).toBe(
      `Invalid arguments: unknown option "-.-."; ${takes}\n`,
    );
    expect((await run(["decode", "morse", "-k"], cli)).stderr).toBe(
      "Invalid arguments: --key needs a value\n",
    );
    expect(execute).not.toHaveBeenCalled();
    expect((await run(["decode", "morse", "-h"], cli)).stdout).toContain("USAGE demo decode");
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
      "Invalid arguments at <TEXT>: stdin is not UTF-8 text\n",
      1,
    ]);
  });

  it("leaves stdout to a package command that answers with no content", () => {
    const answer = spawnSync(process.execPath, [fixture, "gzip-magic"]);
    expect([[...answer.stdout], answer.stderr.length, answer.status]).toEqual([[0x1f, 0x8b], 0, 0]);
    const json = spawnCli(["gzip-magic", "--json"]);
    expect([json.stdout, json.stderr, json.status]).toEqual([
      "",
      'Invalid arguments: unknown option "--json"; takes no options\n',
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
    expect(bad.stderr).toBe("Invalid arguments at --mode: must be one of plain, loud\n");
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
      expect(client.getServerVersion()).toEqual({
        name: "demo",
        version: "1.2.3",
        description: "Demo tools",
      });
    } finally {
      await client.close();
    }
  });

  it("introduces the MCP server with the info mcp was given, not the help line", async () => {
    const client = new Client({ name: "test", version: "0" });
    await client.connect(
      new StdioClientTransport({ command: process.execPath, args: [serverInfoFixture, "mcp"] }),
    );
    try {
      expect(client.getServerVersion()).toEqual(serverInfo);
      expect((await client.listTools()).tools.map((each) => each.name)).toEqual([
        "demo_echo",
        "demo_text_measure",
      ]);
    } finally {
      await client.close();
    }
  });
});
