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
  ToolInputError,
  ToolDefinitionError,
  Type,
  type InputIssue,
  type ToolDefinition,
  type TSchema,
} from "../src/index.ts";
import { demoTools, DemoError, echo, measure, serverInfo } from "./fixtures/demo.ts";

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
const hostFixture = fileURLToPath(new URL("fixtures/host-cli.ts", import.meta.url));
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

  it("hands the fallback a line that opens with one of its flags", async () => {
    expect(normalizeArgv(options, ["--times", "2", "hi"])).toEqual(["echo", "--times", "2", "hi"]);
    expect((await run(["--times", "2", "hi"])).stdout).toBe("hihi\n");
    expect((await run(["--json", "hi"])).stdout).toBe(
      `${JSON.stringify({ word: "hi", times: 1 }, null, 2)}\n`,
    );
    for (const root of ["--help", "-h", "--version", "-v"]) {
      expect(normalizeArgv(options, [root, "hi"])).toEqual([root, "hi"]);
    }
    expect((await run(["--version"])).stdout).toBe("1.2.3\n");
    const typo = await run(["--tims", "2", "hi"]);
    expect(typo.stderr).toContain("--tims");
    expect(typo.exitCode).toBe(1);
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

  it("reads a bare word for a union of a scalar and a list, and JSON for the list", async () => {
    const resolve = defineTool({
      name: "demo_resolve",
      title: "Resolve",
      description: "Resolve threads.",
      effect: "write",
      input: Type.Object(
        {
          threadId: Type.Union([
            Type.String({ minLength: 1 }),
            Type.Array(Type.String(), { minItems: 1 }),
          ]),
          number: Type.Optional(Type.Union([Type.Integer(), Type.Array(Type.Integer())])),
          mode: Type.Optional(Type.Union([Type.Enum(["all"]), Type.Array(Type.String())])),
          filter: Type.Optional(
            Type.Union([
              Type.Null(),
              Type.Object({ q: Type.String() }, { additionalProperties: false }),
            ]),
          ),
        },
        { additionalProperties: false },
      ),
      execute: (input) => ({
        content: [{ type: "text", text: JSON.stringify(input) }],
        details: null,
      }),
    });
    const cli = { ...options, tools: [resolve], default: undefined, fallback: undefined };
    const resolved = async (...argv: readonly string[]) => run(["resolve", ...argv], cli);

    expect((await resolved("--thread-id", "PRRT_abc", "--number", "391")).stdout).toBe(
      '{"threadId":"PRRT_abc","number":391}\n',
    );
    expect((await resolved("--thread-id", "123", "--mode", "all")).stdout).toBe(
      '{"threadId":"123","mode":"all"}\n',
    );
    expect((await resolved("--thread-id", '["a","b"]', "--number", "[1,2]")).stdout).toBe(
      '{"threadId":["a","b"],"number":[1,2]}\n',
    );
    expect((await resolved("--thread-id", "null", "--filter", "null")).stdout).toBe(
      '{"threadId":"null","filter":null}\n',
    );
    expect((await resolved("--thread-id", "[]")).stderr).toContain(
      "Invalid arguments at --thread-id: must not have fewer than 1 items\n",
    );
    expect((await resolved("--thread-id", '""')).stderr).toContain(
      "Invalid arguments at --thread-id: must not have fewer than 1 characters\n",
    );
    expect((await resolved("--thread-id", '"PRRT_abc"')).stdout).toBe('{"threadId":"PRRT_abc"}\n');
    expect((await resolved("--thread-id", "a", "--number", "1.5")).stderr).toContain(
      "Invalid arguments at --number: must be integer\n",
    );
    expect(await resolved("--thread-id", "a", "--filter", "{q")).toEqual({
      stdout: "",
      stderr: "Invalid arguments at --filter: must be JSON\n",
      exitCode: 1,
    });
    const help = (await resolved("--help")).stdout;
    expect(help).toContain("--thread-id=<thread-id|json>");
    expect(help).toContain("--number=<number|json>");
    expect(help).toContain("--mode=<all|json>");
    expect(help).toContain("--filter=<json>");
  });

  it("names the bound a number in a union or an intersection missed", async () => {
    const versions = defineTool({
      name: "demo_versions",
      title: "Versions",
      description: "Lists versions.",
      effect: "read",
      input: Type.Object(
        {
          limit: Type.Optional(Type.Union([Type.Integer({ minimum: 1 }), Type.Enum(["all"])])),
          plain: Type.Optional(Type.Integer({ minimum: 1 })),
          floor: Type.Optional(Type.Intersect([Type.Integer(), Type.Number({ minimum: 1 })])),
        },
        { additionalProperties: false },
      ),
      execute: (input) => ({
        content: [{ type: "text", text: JSON.stringify(input) }],
        details: null,
      }),
    });
    const cli = { ...options, tools: [versions], default: undefined, fallback: undefined };
    const listed = async (...argv: readonly string[]) => run(["versions", ...argv], cli);

    for (const limit of ["0", "-1"]) {
      expect((await listed("--limit", limit)).stderr).toBe(
        [
          "Invalid arguments at --limit: must be >= 1",
          "Invalid arguments at --limit: must be one of all",
          "Invalid arguments at --limit: must match a schema in anyOf",
          "",
        ].join("\n"),
      );
    }
    expect((await listed("--plain", "0")).stderr).toBe(
      "Invalid arguments at --plain: must be >= 1\n",
    );
    expect((await listed("--floor", "0")).stderr).toBe(
      "Invalid arguments at --floor: must be >= 1\n",
    );
    expect((await listed("--limit", "1.5")).stderr).toContain(
      "Invalid arguments at --limit: must be integer\n",
    );
    expect((await listed("--limit", "3", "--floor", "2")).stdout).toBe('{"limit":3,"floor":2}\n');
    expect((await listed("--limit", "all")).stdout).toBe('{"limit":"all"}\n');
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

    it("names the flag in a refusal the executor throws itself", async () => {
      const refusal = (issues: readonly InputIssue[]) =>
        new ToolInputError(
          issues.map((issue) => issue.line),
          issues,
        );
      const cipher = defineTool({
        name: "demo_cipher",
        title: "Cipher",
        description: "Shifts text by a key.",
        effect: "read",
        input: Type.Object(
          { text: Type.String(), key: Type.Optional(Type.String()), mode: Type.String() },
          { additionalProperties: false },
        ),
        cli: { positional: ["text"] },
        execute: ({ mode }) => {
          if (mode === "bare") throw new ToolInputError(["Invalid arguments: key and text clash"]);
          throw refusal([
            {
              line: "Invalid arguments at /key: required for vigenere",
              at: "/key",
              problem: "required for vigenere",
            },
            { line: "Invalid arguments at /text: too short", at: "/text", problem: "too short" },
            {
              line: "Invalid arguments at /alphabet: unknown",
              at: "/alphabet",
              problem: "unknown",
            },
          ]);
        },
      });
      const ciphers: CliOptions = { ...cli, tools: [cipher] };
      expect((await run(["cipher", "abc", "--mode", "vigenere"], ciphers)).stderr).toBe(
        [
          "Invalid arguments at --key: required for vigenere",
          "Invalid arguments at <TEXT>: too short",
          "Invalid arguments at /alphabet: unknown",
          "",
        ].join("\n"),
      );
      expect((await run(["cipher", "abc", "--mode", "bare"], ciphers)).stderr).toBe(
        "Invalid arguments: key and text clash\n",
      );
    });
    it("keeps the executor's hint after the flag it names", async () => {
      const archive = defineTool({
        name: "demo_unzip",
        title: "Unzip",
        description: "Opens an archive.",
        effect: "read",
        input: Type.Object(
          { archive: Type.String(), password: Type.Optional(Type.String()) },
          { additionalProperties: false },
        ),
        cli: { positional: ["archive"] },
        execute: ({ archive }) => {
          const hint = "The archive is encrypted, so pass its password";
          const both = "Name the archive and the password it was made with";
          if (archive === "pair") {
            throw new ToolInputError(
              [`Invalid arguments: missing password and archive. ${both}`],
              [
                {
                  line: `Invalid arguments: missing password and archive. ${both}`,
                  at: "",
                  problem: "must have required properties password, archive",
                  missing: ["password", "archive"],
                  hint: both,
                },
              ],
            );
          }
          if (archive === "short") {
            throw new ToolInputError(
              [`Invalid arguments at /password: too short. ${hint}`],
              [
                {
                  line: `Invalid arguments at /password: too short. ${hint}`,
                  at: "/password",
                  problem: "too short",
                  hint,
                },
              ],
            );
          }
          throw new ToolInputError(
            [`Missing required option: password. ${hint}`],
            [
              {
                line: `Missing required option: password. ${hint}`,
                at: "",
                problem: "must have required properties password",
                missing: ["password"],
                hint,
              },
            ],
          );
        },
      });
      const unzip: CliOptions = { ...cli, tools: [archive] };
      expect((await run(["unzip", "secret.zip"], unzip)).stderr).toBe(
        "Invalid arguments: missing --password. The archive is encrypted, so pass its password\n",
      );
      expect((await run(["unzip", "pair"], unzip)).stderr).toBe(
        [
          "Invalid arguments: missing --password",
          "Invalid arguments: missing <ARCHIVE>. Name the archive and the password it was made with",
          "",
        ].join("\n"),
      );
      expect((await run(["unzip", "short"], unzip)).stderr).toBe(
        "Invalid arguments at --password: too short. The archive is encrypted, so pass its password\n",
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
      "Invalid arguments: --spaced takes no value; use --spaced or --no-spaced\n",
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it("names the --no- form when a boolean that defaults to true gets a value", async () => {
    const lift = defineTool({
      name: "demo_lift",
      title: "Lift",
      description: "x",
      effect: "read",
      input: Type.Object(
        { compressed: Type.Optional(Type.Boolean({ default: true })) },
        { additionalProperties: false },
      ),
      execute: (input) => ({
        content: [{ type: "text", text: JSON.stringify(input) }],
        details: null,
      }),
    });
    const cli: CliOptions = { ...options, tools: [lift], default: undefined, fallback: undefined };
    const execute = vi.spyOn(lift, "execute");
    const refusal =
      "Invalid arguments: --compressed takes no value; use --compressed or --no-compressed\n";
    expect((await run(["lift", "--compressed=false"], cli)).stderr).toBe(refusal);
    expect((await run(["lift", "--no-compressed=true"], cli)).stderr).toBe(refusal);
    expect(execute).not.toHaveBeenCalled();
    expect((await run(["lift", "--no-compressed"], cli)).stdout).toBe('{"compressed":false}\n');
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

  it("prints the scrubbed causes under an expected error, with --json too", async () => {
    const fallback = defineTool({
      name: "demo_fallback",
      title: "Fallback",
      description: "Fail on the second provider.",
      effect: "read",
      input: Type.Object({}),
      execute() {
        const first = new Error("HTTP 502 from https://a.example/v3/s3cret");
        throw new DemoError("Rate limited\nby b", { cause: first });
      },
    });
    const cli: CliOptions = { ...options, commands: [fallback] };
    const failure = {
      stdout: "",
      stderr: "Rate limited by b\ncaused by: HTTP 502 from https://a.example/REDACTED\n",
      exitCode: 1,
    };
    expect(await run(["fallback"], cli)).toEqual(failure);
    expect(await run(["fallback", "--json"], cli)).toEqual(failure);
  });

  it("strips escape sequences, C1 and bidi controls from the text but keeps its layout", async () => {
    expect((await run(["echo", "escape"])).stdout).toBe(
      `aredb\nnext line\t${String.fromCodePoint(0x1f469, 0x200d, 0x1f4bb)}\n`,
    );
  });

  it("prints a verbatim command's text as written but still cleans its errors", async () => {
    const marks = "a\u200Bb\u202Ec\u2066d\u2069\u200F\u001B[31me\r\n";
    const conceal = defineTool({
      name: "demo_conceal",
      title: "Conceal",
      description: "Hide a word in marks.",
      effect: "read",
      input: Type.Object({ word: Type.String() }, { additionalProperties: false }),
      cli: { positional: ["word"], verbatim: true },
      execute: ({ word }) => ({
        content: [
          {
            type: "text",
            text: word === "fail" ? `no ${marks}` : word === "bare" ? "a\u200Fb" : marks,
          },
        ],
        details: { marks },
        isError: word === "fail",
      }),
    });
    const cli = { ...options, tools: [...demoTools, conceal] };
    expect((await run(["conceal", "key"], cli)).stdout).toBe(marks);
    expect((await run(["conceal", "bare"], cli)).stdout).toBe("a\u200Fb\n");
    expect((await run(["conceal", "key", "--json"], cli)).stdout).toBe(
      `{\n  "marks": "a\u200Bb\\u202ec\\u2066d\\u2069\\u200f\\u001b[31me\\r\\n"\n}\n`,
    );
    expect(await run(["conceal", "fail"], cli)).toEqual({
      stdout: "",
      stderr: "no a\u200Bbcde\n",
      exitCode: 1,
    });
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

  it("builds the grapheme segmenter on the first progress line, once", async () => {
    const original = Intl.Segmenter;
    let built = 0;
    class CountedSegmenter extends original {
      constructor(locales?: string, segmenterOptions?: Readonly<Intl.SegmenterOptions>) {
        super(locales, segmenterOptions);
        built += 1;
      }
    }
    Object.defineProperty(Intl, "Segmenter", { value: CountedSegmenter });
    vi.resetModules();
    try {
      const fresh = await import("../src/cli.ts");
      vi.spyOn(process.stdout, "write").mockReturnValue(true);
      vi.spyOn(process.stderr, "write").mockReturnValue(true);
      await fresh.createCli(cli).run(["--help"]);
      const afterHelp = built;
      const before = { isTTY: process.stderr.isTTY, columns: process.stderr.columns };
      Object.assign(process.stderr, { isTTY: true, columns: 80 });
      try {
        await fresh.createCli(cli).run(["slow"]);
        await fresh.createCli(cli).run(["slow"]);
      } finally {
        Object.assign(process.stderr, before);
      }
      expect({ afterHelp, built }).toEqual({ afterHelp: 0, built: 1 });
    } finally {
      Object.defineProperty(Intl, "Segmenter", { value: original });
      vi.resetModules();
    }
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

  it("lists a long enum after its description instead of widening every row", async () => {
    const archives = ["auto", "all", "wayback", "arquivo", "webarchiv", "conifer", "memento"];
    const snapshots = defineTool({
      name: "demo_snapshots",
      title: "Snapshots",
      description: "List captures.",
      effect: "read",
      input: Type.Object(
        {
          provider: Type.Optional(Type.Enum(archives, { description: "Archive to ask." })),
          order: Type.Optional(Type.Enum(["newest", "oldest"], { description: "Which end." })),
          mode: Type.Enum(["strict", "loose", "lenient", "permissive", "relaxed"]),
          limit: Type.Optional(Type.Integer({ description: "Most captures." })),
        },
        { additionalProperties: false },
      ),
      cli: { short: { provider: "p" } },
      execute: (input) => ({ content: [], details: input }),
    });
    const { stdout } = await run(["snapshots", "--help"], cli(snapshots));
    expect(stdout.slice(stdout.indexOf("\nOPTIONS\n") + 1)).toBe(
      [
        "OPTIONS",
        "",
        "  -p, --provider=<provider>  Archive to ask. (one of auto, all, wayback, arquivo, webarchiv, conifer, memento)",
        "  --order=<newest|oldest>    Which end.",
        "  --mode=<mode>              (one of strict, loose, lenient, permissive, relaxed) (required)",
        "  --limit=<number>           Most captures.",
        "  --json                     Print the details as JSON instead of the text",
        "  -h, --help                 Show this help",
        "",
      ].join("\n"),
    );
  });

  it("keeps a long enum inline when its flag name would make the cell wider", async () => {
    const levels = ["a", "b", "c", "d", "e", "f", "g", "h"];
    const encode = defineTool({
      name: "demo_encode",
      title: "Encode",
      description: "Encode.",
      effect: "read",
      input: Type.Object(
        { outputEncodingScheme: Type.Optional(Type.Enum(levels)) },
        { additionalProperties: false },
      ),
      execute: (input) => ({ content: [], details: input }),
    });
    const { stdout } = await run(["encode", "--help"], cli(encode));
    expect(stdout).toContain("\n  --output-encoding-scheme=<a|b|c|d|e|f|g|h>\n");
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

describe("CLI flag aliases", () => {
  const list = defineTool({
    name: "chains_list",
    title: "List chains",
    description: "List chains.",
    effect: "read",
    input: Type.Object(
      {
        family: Type.Optional(Type.String()),
        query: Type.Optional(Type.String()),
        provider: Type.Optional(Type.String()),
        exact: Type.Optional(Type.Boolean()),
      },
      { additionalProperties: false },
    ),
    cli: {
      positional: ["family", "query"],
      flags: { family: ["type", "family"], provider: ["source"], exact: ["strict"] },
    },
    execute: (input) => ({
      content: [{ type: "text", text: JSON.stringify(input) }],
      details: null,
    }),
  });
  const cli = (tool: ToolDefinition = list): CliOptions => ({
    ...options,
    tools: [tool],
    default: undefined,
    fallback: undefined,
  });
  const stdout = async (argv: readonly string[]) => (await run(argv, cli())).stdout;

  it("keeps an old flag name on a positional", async () => {
    for (const argv of [
      ["list", "utxo"],
      ["list", "--type", "utxo"],
      ["list", "--type=utxo"],
      ["list", "--family", "utxo"],
    ]) {
      expect(await stdout(argv)).toBe('{"family":"utxo"}\n');
    }
  });

  it("hands the place of a positional set by its flag to the next one", async () => {
    expect(await stdout(["list", "--type", "utxo", "btc"])).toBe(
      '{"family":"utxo","query":"btc"}\n',
    );
    expect(await stdout(["list", "btc", "--type", "utxo"])).toBe(
      '{"family":"utxo","query":"btc"}\n',
    );
    expect(await stdout(["list", "--type", "utxo", "-5"])).toBe('{"family":"utxo","query":"-5"}\n');
    expect((await run(["list", "evm", "btc", "--type", "utxo"], cli())).stderr).toBe(
      "Invalid arguments: 1 unexpected positional argument\n",
    );
    expect((await run(["list", "--type", "utxo", "btc", "-5"], cli())).stderr).toBe(
      'Invalid arguments: unknown option "-5"; takes --provider, --exact, --json\n',
    );
  });

  it("keeps old names on options and booleans", async () => {
    expect(await stdout(["list", "--source", "osm", "--strict"])).toBe(
      '{"provider":"osm","exact":true}\n',
    );
    expect(await stdout(["list", "--no-strict"])).toBe('{"exact":false}\n');
    expect(await stdout(["list", "--provider", "osm", "--no-exact"])).toBe(
      '{"provider":"osm","exact":false}\n',
    );
  });

  it("names the old flag the line used when it fails", async () => {
    const tool = cli();
    const execute = vi.spyOn(list, "execute");
    const stderr = async (argv: readonly string[]) => (await run(argv, tool)).stderr;
    expect(await stderr(["list", "--source", "a", "--provider", "b"])).toBe(
      "Invalid arguments: --provider given more than once\n",
    );
    expect(await stderr(["list", "--type", "a", "--type", "b"])).toBe(
      "Invalid arguments: --type given more than once\n",
    );
    expect(await stderr(["list", "--type"])).toBe("Invalid arguments: --type needs a value\n");
    expect(await stderr(["list", "--no-strict", "--no-strict"])).toBe(
      "Invalid arguments: --strict given more than once\n",
    );
    expect(await stderr(["list", "--strict=yes"])).toBe(
      "Invalid arguments: --strict takes no value; use --strict or --no-strict\n",
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it("leaves the old names out of the help and the unknown option line", async () => {
    const { stdout: help } = await run(["list", "--help"], cli());
    expect(help).toContain("USAGE demo list [OPTIONS] [FAMILY] [QUERY]\n");
    for (const old of ["--type", "--family", "--source", "--strict"])
      expect(help).not.toContain(old);
    expect((await run(["list", "evm", "btc", "--nope"], cli())).stderr).toBe(
      'Invalid arguments: unknown option "--nope"; takes --provider, --exact, --json\n',
    );
  });

  it("rejects old names that clash or can't be typed", () => {
    const build = (flags: Readonly<Record<string, readonly string[]>>) => () =>
      createCli(cli({ ...list, cli: { positional: ["family"], flags } }));
    expect(build({ nope: ["x"] })).toThrow("chains_list: cli hint names unknown property nope");
    expect(build({ family: "type" } as unknown as Record<string, string[]>)).toThrow(
      "chains_list: flags of family must be a list of names",
    );
    expect(build({ provider: ["exact"] })).toThrow(
      "chains_list: properties provider and exact both answer to --exact",
    );
    expect(build({ family: ["source"], provider: ["source"] })).toThrow(
      "chains_list: properties family and provider both answer to --source",
    );
    expect(build({ exact: ["provider"] })).toThrow(
      "chains_list: properties provider and exact both answer to --provider",
    );
    expect(build({ provider: ["provider"] })).toThrow(
      "chains_list: property provider answers to --provider twice",
    );
    expect(build({ family: ["type", "type"] })).toThrow(
      "chains_list: property family answers to --type twice",
    );
    expect(build({ query: ["json"] })).toThrow(
      "chains_list: property query takes the reserved flag --json",
    );
    expect(build({ provider: ["Source"] })).toThrow(/gives the flag "Source", which must match/);
    expect(build({ exact: ["no-strict"] })).toThrow(
      "chains_list: boolean property exact cannot take a flag starting with no-",
    );
    expect(build({ exact: ["cached"], provider: ["no-cached"] })).toThrow(
      "chains_list: properties provider and exact both answer to --no-cached",
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

  it("keeps dashed words out of a plain positional", async () => {
    const plain = { ...decode, cli: { ...decode.cli, plain: ["cipher"] } };
    const strict: CliOptions = { ...cli, tools: [plain] };
    const execute = vi.spyOn(plain, "execute");
    expect(await run(["decode", "--withPubkey"], strict)).toEqual({
      stdout: "",
      stderr: `Invalid arguments: unknown option "--withPubkey"; ${takes}\n`,
      exitCode: 1,
    });
    expect((await run(["decode", "-.-.", "morse"], strict)).stderr).toBe(
      `Invalid arguments: unknown option "-.-."; ${takes}\n`,
    );
    expect((await run(["decode", "-.-.", "--kye", "x"], strict)).stderr).toBe(
      [
        `Invalid arguments: unknown option "-.-."; ${takes}`,
        `Invalid arguments: unknown option "--kye"; ${takes}`,
        "",
      ].join("\n"),
    );
    expect(execute).not.toHaveBeenCalled();
    expect((await run(["decode", "morse", "-.-. .- -"], strict)).stdout).toBe(
      `{"cipher":"morse","text":"-.-. .- -"}\n`,
    );
    expect((await run(["decode", "-k", "x", "--", "-5"], strict)).stdout).toBe(
      `{"cipher":"-5","key":"x"}\n`,
    );
  });

  it("refuses dashed words in a plain rest and leaves the plain ones alone", async () => {
    const search = defineTool({
      name: "demo_search",
      title: "Search",
      description: "Search for words.",
      effect: "read",
      input: Type.Object(
        { digest: Type.String(), words: Type.Array(Type.String()) },
        { additionalProperties: false },
      ),
      cli: { positional: ["digest"], rest: "words", plain: ["words"] },
      execute: (input) => ({
        content: [{ type: "text", text: JSON.stringify(input) }],
        details: null,
      }),
    });
    const words: CliOptions = { ...cli, tools: [search] };
    expect((await run(["search", "-ab12", "venus"], words)).stdout).toBe(
      `{"digest":"-ab12","words":["venus"]}\n`,
    );
    expect((await run(["search", "ab12", "-venus"], words)).stderr).toBe(
      'Invalid arguments: unknown option "-venus"; takes --json\n',
    );
  });

  it("rejects a plain hint on a property that takes no positional word", () => {
    const build = (hints: object) => () =>
      createCli({ ...cli, tools: [{ ...decode, cli: { ...decode.cli, ...hints } }] });
    expect(build({ plain: ["key"] })).toThrow("demo_decode: plain property key must be positional");
    expect(build({ plain: ["nope"] })).toThrow("demo_decode: cli hint names unknown property nope");
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
    for (const word of ["--foo", "-x", "", " lead", "group --foo"]) {
      await expect(build(tool({ command: word }))).rejects.toThrow(/must match/);
      expect(() =>
        createCli({ ...options, tools: [tool({ command: "ok", aliases: [word] })] }),
      ).toThrow(/must match/);
    }
    await expect(build(tool({ command: "one two three" }))).rejects.toThrow(/two words at most/);
    expect(() =>
      createCli({ ...options, tools: [tool({ command: "ok", aliases: ["two words"] })] }),
    ).toThrow(/must match/);
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

describe("CLI command groups", () => {
  const servers = (command: string, aliases?: readonly string[]) =>
    defineTool({
      name: `demo_servers_${command.replaceAll(" ", "_")}`,
      title: command,
      description: `Servers ${command}.`,
      effect: "read",
      input: Type.Object(
        { id: Type.Optional(Type.String({ description: "Harness id" })) },
        { additionalProperties: false },
      ),
      cli: { command: `servers ${command}`, positional: ["id"], aliases },
      execute: ({ id }) => ({
        content: [{ type: "text", text: `${command} ${id ?? "all"}` }],
        details: null,
      }),
    });
  const grouped: CliOptions = {
    name: "demo",
    version: "1.2.3",
    description: "Demo tools",
    tools: [echo, servers("list", ["ls"]), servers("add"), measure],
    groups: { servers: { description: "Manage servers", aliases: ["srv"] } },
  };

  it("runs a command by its group and name, an alias at either level", async () => {
    expect((await run(["servers", "list"], grouped)).stdout).toBe("list all\n");
    expect((await run(["servers", "add", "pi"], grouped)).stdout).toBe("add pi\n");
    expect((await run(["srv", "ls", "pi"], grouped)).stdout).toBe("list pi\n");
    expect((await run(["echo", "hi"], grouped)).stdout).toBe("hi\n");
  });

  it("lists a group once, where its first command stood, and its commands in its own help", async () => {
    const root = (await run(["--help"], grouped)).stdout;
    expect(root).toMatch(/^ {2}servers, srv +Manage servers$/m);
    expect(root).not.toContain("list");
    expect(root.indexOf("echo")).toBeLessThan(root.indexOf("servers"));
    expect(root.indexOf("servers")).toBeLessThan(root.indexOf("measure"));
    const group = (await run(["servers", "--help"], grouped)).stdout;
    expect(group).toContain("Manage servers (demo servers v1.2.3)\n");
    expect(group).toContain("USAGE demo servers <command> [OPTIONS]\n");
    expect(group).toContain("  list, ls  Servers list.\n");
    expect(group).toContain("Use demo servers <command> --help");
  });

  it("shows a bare group's usage on stderr and fails, like a bare root", async () => {
    const bare = await run(["servers"], grouped);
    expect(bare.stdout).toBe("");
    expect(bare.stderr).toContain("USAGE demo servers <command> [OPTIONS]");
    expect(bare.stderr).toContain("No command specified\n");
    expect(bare.exitCode).toBe(1);
  });

  it("names an unknown second word with its group", async () => {
    const typo = await run(["servers", "lsit"], grouped);
    expect(typo.stderr).toBe(
      'Unknown command "servers lsit"\nRun demo servers --help for the commands\n',
    );
    expect(typo.exitCode).toBe(1);
  });

  it("gives a grouped command its full path in the usage", async () => {
    const { stdout } = await run(["servers", "ls", "--help"], grouped);
    expect(stdout).toContain("(demo servers list v1.2.3)");
    expect(stdout).toContain("USAGE demo servers list [OPTIONS] [ID]");
  });

  it("names the group's commands when no description says more", async () => {
    const { stdout } = await run(["--help"], { ...grouped, groups: undefined });
    expect(stdout).toMatch(/^ {2}servers +list, add$/m);
    expect((await run(["servers", "-h"], { ...grouped, groups: undefined })).stdout).toContain(
      "Commands of servers (demo servers v1.2.3)",
    );
  });

  it("takes two words as default and fallback", async () => {
    const both: CliOptions = { ...grouped, default: "servers list", fallback: "servers add" };
    expect(normalizeArgv(both, [])).toEqual(["servers", "list"]);
    expect((await run([], both)).stdout).toBe("list all\n");
    expect((await run(["pi"], both)).stdout).toBe("add pi\n");
    expect(normalizeArgv(both, ["srv", "ls"])).toEqual(["srv", "ls"]);
    expect(() => createCli({ ...grouped, default: "servers" })).toThrow(/no command servers/);
    expect(() => createCli({ ...grouped, fallback: "servers nope" })).toThrow(
      /no command servers nope/,
    );
  });

  it("rejects clashes inside a group and between a group and a command", () => {
    expect(() =>
      createCli({ ...grouped, tools: [servers("list"), servers("add", ["list"])] }),
    ).toThrow(/Two commands are named servers list/);
    const clash = defineTool({ ...echo, name: "demo_servers", cli: { command: "servers" } });
    expect(() => createCli({ ...grouped, tools: [clash, servers("list")] })).toThrow(
      /Two commands are named servers/,
    );
    expect(() => createCli({ ...grouped, groups: { servers: { aliases: ["echo"] } } })).toThrow(
      /Two commands are named echo/,
    );
    expect(() => createCli({ ...grouped, groups: { nope: {} } })).toThrow(/no group nope/);
    expect(() => createCli({ ...grouped, groups: { servers: { aliases: ["--x"] } } })).toThrow(
      /must match/,
    );
  });

  it("keeps commands of one word as they were", () => {
    expect(commandName(servers("list"))).toBe("servers list");
    expect(commandName(echo)).toBe("echo");
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
    const client = new Client(
      { name: "test", version: "0" },
      { versionNegotiation: { mode: "legacy" } },
    );
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

  it("finds no request over stdio, only the _meta a call brought along", async () => {
    const client = new Client({ name: "test", version: "0" });
    await client.connect(
      new StdioClientTransport({ command: process.execPath, args: [hostFixture, "mcp"] }),
    );
    try {
      const bare = await client.callTool({ name: "demo_host", arguments: {} });
      expect(bare.content).toEqual([
        { type: "text", text: '{"host":false,"request":false,"meta":null}' },
      ]);
      const tagged = await client.callTool({
        name: "demo_host",
        arguments: {},
        _meta: { "ai.opencode/sessionID": "ses_meta" },
      });
      expect(tagged.content).toEqual([
        {
          type: "text",
          text: '{"host":true,"request":false,"meta":{"ai.opencode/sessionID":"ses_meta"}}',
        },
      ]);
    } finally {
      await client.close();
    }
  });

  it("lets a 2026 client listen on mcp and promises nothing it can't send", async () => {
    const client = new Client(
      { name: "test", version: "0" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } },
    );
    await client.connect(
      new StdioClientTransport({ command: process.execPath, args: [fixture, "mcp"] }),
    );
    try {
      const subscription = await client.listen({
        toolsListChanged: true,
        resourceSubscriptions: ["file:///x"],
      });
      expect(subscription.honoredFilter).toEqual({});
      expect((await client.listTools()).tools.map((each) => each.name)).toEqual([
        "demo_echo",
        "demo_text_measure",
      ]);
      await subscription.close();
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
