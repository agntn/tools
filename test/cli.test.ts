import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { runCommand } from "citty";
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

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

/**
 * Runs the CLI in process, as citty would after `normalizeArgv`.
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
  await runCommand(createCli(cli), { rawArgs: await normalizeArgv(cli, argv) });
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

  it("prints details with --json", async () => {
    expect((await run(["echo", "hi", "--times", "2", "--json"])).stdout).toBe(
      `${JSON.stringify({ word: "hi", times: 2 }, null, 2)}\n`,
    );
  });

  it("applies the fallback, the default and the aliases", async () => {
    expect((await run(["hi"])).stdout).toBe("hi\n");
    expect(await normalizeArgv(options, [])).toEqual(["measure"]);
    expect(await normalizeArgv(options, ["--help"])).toEqual(["--help"]);
    expect(await normalizeArgv(options, ["-"])).toEqual(["echo", "-"]);
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
    expect(execute).not.toHaveBeenCalled();
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
    const cli: CliOptions = {
      ...options,
      commands: {
        echo: { meta: { name: "echo" }, run: () => process.stdout.write("own echo\n") },
        info: () => ({
          meta: { name: "info", alias: "i" },
          run() {
            throw new DemoError("no info");
          },
        }),
      },
    };
    expect((await run(["echo", "hi"], cli)).stdout).toBe("own echo\n");
    expect(await run(["info"], cli)).toEqual({ stdout: "", stderr: "no info\n", exitCode: 1 });
    // A lazy command's alias is not a word for the fallback.
    expect((await run(["i"], cli)).stderr).toBe("no info\n");
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
  });

  it("rejects two commands of one name and a default that names none", () => {
    expect(() => createCli({ ...options, tools: [echo, tool({ command: "echo" })] })).toThrow(
      /Two commands are named echo/,
    );
    expect(() => createCli({ ...options, default: "nope" })).toThrow(/no command nope/);
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
    expect(bad.stderr).toContain("Expected one of: plain, loud.");
    expect(bad.stderr).not.toContain("\u001B[");
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
