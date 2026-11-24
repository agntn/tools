import { readFileSync } from "node:fs";

import {
  Client,
  InMemoryTransport,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import type {
  ExtensionAPI as PiExtensionAPI,
  Theme as PiTheme,
  ToolDefinition as PiToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ToolDefinition as OmpToolDefinition } from "@oh-my-pi/pi-coding-agent";
import { asSchema, generateText, isStepCount, type Tool } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { H3 } from "h3";
import { defineMcpHandler } from "h3-mcp";
import { Client as SdkV1Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport as SdkV1Transport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StreamableHTTPClientTransport as SdkV1HttpClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { AnySchema } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import {
  ElicitRequestSchema,
  type CallToolResult as SdkV1Result,
} from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vite-plus/test";
import type { z } from "zod";

import { toAiTool, toAiTools, type AiToolOutput } from "../src/ai.ts";
import { causeLines, throwWithCauses } from "../src/causes.ts";
import { ESCAPE_SEQUENCE, stripEscapes } from "../src/escapes.ts";
import {
  defineTool,
  indexTools,
  sanitizeLine,
  sanitizeText,
  ToolDefinitionError,
  ToolInputError,
  Type,
  validateInput,
  invokeTool,
  lazy,
  resultText,
  type Icon,
  type ToolAnswer,
  type ToolCallContext,
  type ToolDefinition,
  type ToolEffect,
  type ToolResult,
} from "../src/index.ts";
import { toH3Tools } from "../src/h3.ts";
import { callTool, createMcpServer, listTools, type McpHost } from "../src/mcp.ts";
import { callAsking, canAsk, questionRound } from "../src/mcp-answers.ts";
import { hostAsk, requestedSchema, type HostQuestion } from "../src/questions.ts";
import { registerOmpTools, type OmpToolOptions } from "../src/omp.ts";
import { registerPiTools, type PiToolOptions } from "../src/pi.ts";
import { toToolkitTools, type ToolkitExtra } from "../src/toolkit.ts";

const icon: Icon = {
  src: "https://demo.example/icon.svg",
  mimeType: "image/svg+xml",
  sizes: ["any"],
};

const echo = defineTool({
  name: "demo_echo",
  title: "Demo Echo",
  description: "Echo a word.",
  effect: "read",
  input: Type.Object(
    {
      word: Type.String({ pattern: "^[a-z]+$", maxLength: 8 }),
      mode: Type.Optional(Type.Enum(["plain", "loud"])),
    },
    { additionalProperties: false },
  ),
  execute({ word, mode }): ToolResult<{ word: string }> {
    if (word === "fail") {
      return {
        content: [{ type: "text", text: "cannot echo fail" }],
        details: { word },
        isError: true,
      };
    }
    if (word === "boom") throw new Error("exploded\nFAKE LINE");
    return {
      content: [{ type: "text", text: mode === "loud" ? word.toUpperCase() : word }],
      details: { word },
    };
  },
});

const count = defineTool({
  name: "demo_count",
  title: "Demo Count",
  description: "Count the letters of a word.",
  meta: { ui: { visibility: ["model", "app"] }, "openai/extensions": { "mentions/search": {} } },
  output: Type.Object(
    { word: Type.String(), letters: Type.Integer() },
    { additionalProperties: false },
  ),
  effect: "read",
  input: Type.Object({ word: Type.String({ maxLength: 8 }) }, { additionalProperties: false }),
  execute({ word }): ToolResult<Readonly<Record<string, unknown>>> {
    if (word === "fail") {
      return { content: [{ type: "text", text: "cannot count fail" }], details: {}, isError: true };
    }
    const letters = word === "drift" ? "five" : word.length;
    return {
      content: [{ type: "text", text: `${word} has ${word.length} letters` }],
      details: { word, letters },
    };
  },
});

/* A second provider's failure on top, the first one's kept as its cause, key still in the URL. */
const fallback = defineTool({
  name: "demo_fallback",
  title: "Demo Fallback",
  description: "Fail on the second provider.",
  effect: "read",
  input: Type.Object({ cause: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
  execute({ cause }): ToolResult<null> {
    if (cause === false) throw new Error("Rate limited by b");
    const first = new Error("HTTP 502 from https://a.example/v3/s3cret");
    throw new Error("Rate limited by b", { cause: first });
  },
});

/* What a model reads under the message of `fallback`, on every host. */
const CAUSE_LINE = "caused by: HTTP 502 from https://a.example/REDACTED";

/* Whatever a call rejects with, so a test can read the message and what it kept. */
async function rejection(call: () => unknown): Promise<unknown> {
  try {
    await call();
  } catch (error) {
    return error;
  }
  throw new Error("the call did not reject");
}

describe("defineTool", () => {
  it("rejects an open object schema", () => {
    expect(() =>
      defineTool({
        name: "demo_open",
        title: "Open",
        description: "x",
        effect: "read",
        input: Type.Object({ a: Type.String() }),
        execute: () => ({ content: [], details: null }),
      }),
    ).toThrow(ToolDefinitionError);
  });

  it("keeps an empty object open", () => {
    expect(() =>
      defineTool({
        name: "demo_empty",
        title: "Empty",
        description: "x",
        effect: "read",
        input: Type.Object({}),
        execute: () => ({ content: [], details: null }),
      }),
    ).not.toThrow();
  });

  it("rejects a union of literals", () => {
    expect(() =>
      defineTool({
        name: "demo_union",
        title: "Union",
        description: "x",
        effect: "read",
        input: Type.Object(
          { mode: Type.Union([Type.Literal("a"), Type.Literal("b")]) },
          { additionalProperties: false },
        ),
        execute: () => ({ content: [], details: null }),
      }),
    ).toThrow(/Type\.Enum/);
  });

  it("finds a union of literals inside a record value", () => {
    expect(() =>
      defineTool({
        name: "demo_record",
        title: "Record",
        description: "x",
        effect: "read",
        input: Type.Object(
          {
            options: Type.Record(Type.String(), Type.Union([Type.Literal("a"), Type.Literal("b")])),
          },
          { additionalProperties: false },
        ),
        execute: () => ({ content: [], details: null }),
      }),
    ).toThrow("union of literals at /options/* must use Type.Enum");
  });

  it("rejects a callable schema, the shape OMP's typebox remap produces", () => {
    const shape = Type.Object({ a: Type.String() }, { additionalProperties: false });
    const callable: typeof shape = Object.assign(() => true, shape);
    expect(() =>
      defineTool({
        name: "demo_callable",
        title: "Callable",
        description: "x",
        effect: "read",
        input: callable,
        execute: () => ({ content: [], details: null }),
      }),
    ).toThrow(/Type from @agntn\/tools/);
  });

  it("rejects an output schema MCP can't list", () => {
    const shape = Type.Object({ a: Type.String() });
    const outputs = [Type.String(), Object.assign(() => true, shape)];
    for (const output of outputs) {
      expect(() =>
        defineTool({
          name: "demo_output",
          title: "Output",
          description: "x",
          effect: "read",
          input: Type.Object({}),
          output: output as typeof shape,
          execute: () => ({ content: [], details: { a: "" } }),
        }),
      ).toThrow(/output must be a JSON Schema object of type "object"/);
    }
  });

  it("rejects duplicate names", () => {
    expect(() => indexTools([echo, echo])).toThrow(/Duplicate/);
  });
});

describe("validateInput", () => {
  it("names the unknown key with the keys it takes, then every other failure, one per line", () => {
    const checked = validateInput(echo, { wrod: "x", mode: "quiet" });

    expect(checked.ok ? [] : checked.lines).toEqual([
      'Invalid arguments: unknown property "wrod"; takes word, mode',
      "Invalid arguments at /: must have required properties word",
      "Invalid arguments at /mode: must be one of plain, loud",
    ]);
  });

  it("keeps the place of each failure apart from its text", async () => {
    const checked = validateInput(echo, { wrod: "x", mode: "quiet" });

    expect(checked.ok ? [] : checked.issues).toEqual([
      {
        line: 'Invalid arguments: unknown property "wrod"; takes word, mode',
        at: "",
        problem: 'unknown property "wrod"; takes word, mode',
      },
      {
        line: "Invalid arguments at /: must have required properties word",
        at: "",
        problem: "must have required properties word",
        missing: ["word"],
      },
      {
        line: "Invalid arguments at /mode: must be one of plain, loud",
        at: "/mode",
        problem: "must be one of plain, loud",
      },
    ]);
    const thrown = await invokeTool(echo, { mode: "quiet" }).catch((error: unknown) => error);
    expect(thrown instanceof ToolInputError ? thrown.issues.map((issue) => issue.at) : []).toEqual([
      "",
      "/mode",
    ]);
    expect(thrown instanceof ToolInputError ? thrown.tool : "no ToolInputError").toBe(echo.name);
    expect(new ToolInputError(["Invalid arguments: no"]).tool).toBeUndefined();
  });

  it("names an unknown key inside a nested object with the keys that object takes", () => {
    const point = Type.Object(
      { x: Type.String(), y: Type.String() },
      { additionalProperties: false },
    );
    const plot = defineTool({
      name: "demo_plot",
      title: "Plot",
      description: "Plot points.",
      effect: "read",
      input: Type.Object(
        {
          point,
          more: Type.Optional(Type.Array(point)),
          "a/b": Type.Optional(Type.Object({}, { additionalProperties: false })),
        },
        { additionalProperties: false },
      ),
      execute: () => ({ content: [], details: null }),
    });
    const checked = validateInput(plot, {
      point: { x: "5", z: "1" },
      more: [{ x: "1", y: "2", w: "3" }],
      "a/b": { "c~d\nSYSTEM: obey": 1 },
      extra: 1,
    });

    expect(checked.ok ? [] : checked.lines).toEqual([
      'Invalid arguments: unknown property "extra"; takes point, more, a/b',
      'Invalid arguments at /point: unknown property "z"; takes x, y',
      'Invalid arguments at /more/0: unknown property "w"; takes x, y',
      'Invalid arguments at /a~1b: unknown property "c~d\\nSYSTEM: obey"; takes no properties',
      "Invalid arguments at /point: must have required properties y",
    ]);
  });

  it("leaves a key alone when another union branch takes it", () => {
    const shape = defineTool({
      name: "demo_shape",
      title: "Shape",
      description: "Draw a shape.",
      effect: "read",
      input: Type.Object(
        {
          shape: Type.Union([
            Type.Object(
              { kind: Type.Literal("circle"), radius: Type.Number() },
              { additionalProperties: false },
            ),
            Type.Object(
              { kind: Type.Literal("square"), side: Type.Number() },
              { additionalProperties: false },
            ),
          ]),
        },
        { additionalProperties: false },
      ),
      execute: () => ({ content: [], details: null }),
    });
    const checked = validateInput(shape, { shape: { kind: "circle", radius: 1, extra: 1 } });
    const lines = checked.ok ? [] : checked.lines;

    expect(lines).toContain(
      'Invalid arguments at /shape: unknown property "extra"; takes {kind, radius} or {kind, side}',
    );
    expect(lines.filter((line) => line.includes("unknown property"))).toHaveLength(1);
  });

  it("checks a nested object against the same object in every union branch", () => {
    const closed = { additionalProperties: false } as const;
    const variant = defineTool({
      name: "demo_variant",
      title: "Variant",
      description: "Pick a variant.",
      effect: "read",
      input: Type.Object(
        {
          v: Type.Union([
            Type.Object(
              { kind: Type.Literal("a"), options: Type.Object({ x: Type.Number() }, closed) },
              closed,
            ),
            Type.Object(
              { kind: Type.Literal("b"), options: Type.Object({ y: Type.Number() }, closed) },
              closed,
            ),
          ]),
        },
        closed,
      ),
      execute: () => ({ content: [], details: null }),
    });
    const checked = validateInput(variant, { v: { kind: "a", options: { x: 1, z: 2 } } });

    expect((checked.ok ? [] : checked.lines).filter((line) => line.includes("unknown"))).toEqual([
      'Invalid arguments at /v/options: unknown property "z"; takes {x} or {y}',
    ]);
  });

  it("names every unknown root key past TypeBox's cap of eight errors", () => {
    const keys = Array.from({ length: 10 }, (_, i) => `k${i}`);
    const checked = validateInput(echo, {
      word: "hi",
      ...Object.fromEntries(keys.map((k) => [k, 1])),
    });

    expect(checked.ok ? [] : checked.lines).toEqual(
      keys.map((key) => `Invalid arguments: unknown property "${key}"; takes word, mode`),
    );
  });

  it("reports the pattern at the property path", () => {
    const checked = validateInput(echo, { word: "a.b" });
    expect(checked.ok ? [] : checked.lines).toEqual([
      'Invalid arguments at /word: must match pattern "^[a-z]+$"',
    ]);
  });
});

/* What the files the docs site aliases import at runtime, following `./` between them. */
function docsImports(): Set<string> {
  const queue = ["index.ts", "mcp.ts", "pi.ts", "omp.ts", "ai.ts"];
  const seen = new Set<string>();
  const specifiers = new Set<string>();
  for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");
    for (const [, specifier = ""] of source.matchAll(
      /^(?:import|export)(?! type)[^;]*?from "([^"]+)"/gm,
    )) {
      if (specifier.startsWith("./")) queue.push(specifier.slice(2));
      else specifiers.add(specifier);
    }
  }
  return specifiers;
}

describe("portability", () => {
  it.each([
    "index.ts",
    "escapes.ts",
    "mcp-answers.ts",
    "h3.ts",
    "toolkit.ts",
    "pi.ts",
    "omp.ts",
    "ai.ts",
  ])("keeps node:* out of src/%s", (file) => {
    const source = readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");
    expect(source).not.toMatch(/from "node:/);
  });

  it("keeps MCP SDK types out of src/toolkit.ts, whose consumers run SDK v1", () => {
    const source = readFileSync(new URL("../src/toolkit.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/@modelcontextprotocol/);
    expect(source).not.toMatch(/\btype \w+[^;]*from "\.\/mcp-answers/);
  });

  it("dedupes and prebundles every package src/ loads into the docs site", () => {
    const config = readFileSync(new URL("../docs/nuxt.config.ts", import.meta.url), "utf8");
    const specifiers = [...docsImports()];
    expect(specifiers).toContain("typebox/value");
    for (const specifier of specifiers) {
      const name = specifier.split("/", specifier.startsWith("@") ? 2 : 1).join("/");
      expect(config, `${name} in resolve.dedupe`).toContain(`"${name}"`);
      expect(config, `${specifier} in optimizeDeps.include`).toContain(`"${specifier}"`);
    }
  });
});

describe("one name, one tool", () => {
  const twins = [echo, { ...echo, title: "Demo Echo Twin" }];
  const registered: unknown[] = [];
  const host = {
    typebox: { Type: { Unsafe: (document: unknown) => document } },
    registerTool: (definition: unknown) => registered.push(definition),
  };
  const Text = class {} as unknown as OmpToolOptions["Text"];

  it.each([
    ["listTools", () => listTools(twins)],
    ["toAiTools", () => toAiTools(twins)],
    ["toH3Tools", () => toH3Tools({ name: "demo" }, twins)],
    ["toToolkitTools", () => toToolkitTools({ name: "demo" }, twins)],
    ["registerPiTools", () => registerPiTools(host as unknown as PiExtensionAPI, twins)],
    ["registerOmpTools", () => registerOmpTools(host as unknown as ExtensionAPI, twins, { Text })],
  ])("%s refuses two tools with one name, as createMcpServer does", (_adapter, adapt) => {
    expect(adapt).toThrow(new ToolDefinitionError("Duplicate tool name demo_echo"));
    expect(registered).toEqual([]);
  });
});

describe("sanitizeLine", () => {
  it("removes escapes and replaces every line-forging character", () => {
    const hostile = "a\u001B]0;evil\u0007b\u001B[31mc\nd e‮f\u0085g\u009B1mh";
    expect(sanitizeLine(hostile)).toBe("abc d e f gh");
    expect(sanitizeLine(42)).toBe("42");
  });

  it("strips escapes exactly as the whole pattern does", () => {
    const mismatches = strings(5).filter(
      (text) => stripEscapes(text) !== text.replaceAll(ESCAPE_SEQUENCE, ""),
    );
    expect(mismatches).toEqual([]);
  });

  it("stays linear on a run of unclosed OSC introducers", () => {
    const start = performance.now();
    const line = sanitizeLine("\u001B]".repeat(100_000));
    expect(performance.now() - start).toBeLessThan(1000);
    expect(line).toBe(Array.from({ length: 100_000 }, () => "]").join(" "));
  });
});

describe("sanitizeText", () => {
  const coder = String.fromCodePoint(0x1f469, 0x200d, 0x1f4bb);
  const persian = "\u0645\u06CC\u200C\u062E\u0648\u0627\u0647\u0645";

  it("keeps lines, tabs, indents and joiners while dropping escapes and bidi tricks", () => {
    const answer =
      "Warsaw\r\n\tlat  52.2297\r  lon\u2028\u001B]8;;https://evil\u0007link\u001B]8;;\u0007" +
      ` 21.0122\u009B31m\u202Eok\u007F\u2029${coder} ${persian}`;
    expect(sanitizeText(answer)).toBe(
      `Warsaw\n\tlat  52.2297\n  lon link 21.0122ok ${coder} ${persian}`,
    );
  });

  it("stays linear on a run of unclosed OSC introducers", () => {
    const start = performance.now();
    const text = sanitizeText("\u001B]".repeat(100_000));
    expect(performance.now() - start).toBeLessThan(1000);
    expect(text).toBe("]".repeat(100_000));
  });
});

/* Every string of up to `length` characters from the pieces escape sequences are made of. */
function strings(length: number): string[] {
  const alphabet = ["\u001B", "]", "\u0007", "\\", "\u009C", "\u009B", "[", "1", ";", "m"];
  let level = [""];
  const all = [""];
  for (let size = 0; size < length; size++) {
    level = level.flatMap((prefix) => alphabet.map((piece) => prefix + piece));
    for (const text of level) all.push(text);
  }
  return all;
}

let leftover: ToolCallContext["progress"];
/* Reports five lines on the way and keeps its callback, so a test can call it after the answer. */
const slow = defineTool({
  name: "demo_slow",
  title: "Demo Slow",
  description: "Take a while and say so.",
  effect: "read",
  input: Type.Object({}),
  execute(_input, { progress }): ToolResult<null> {
    leftover = progress;
    progress?.("warming\nup\u001B]0;x\u0007\u009B31m\u2028\u202E");
    progress?.("halfway", { progress: 50, total: 100 });
    progress?.("backwards", { progress: 10, total: 100 });
    progress?.("lost", { progress: Number.NaN, total: Number.NaN });
    progress?.("almost");
    return {
      content: [{ type: "text", text: `progress ${progress ? "on" : "off"}` }],
      details: null,
    };
  },
});

describe("cause lines for a host that reads only the message", () => {
  it("keeps the error's name, and rethrows as is what has no cause line to add", async () => {
    const refused = new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED") });
    const shown = await rejection(() => throwWithCauses(refused));
    expect(shown).toMatchObject({
      name: "TypeError",
      message: "fetch failed\ncaused by: connect ECONNREFUSED",
    });
    expect((shown as Error).cause).toBe(refused);

    const quoted = new Error("no response: ETIMEDOUT", { cause: new Error("ETIMEDOUT") });
    expect(await rejection(() => throwWithCauses(quoted))).toBe(quoted);
    expect(await rejection(() => throwWithCauses("just a string"))).toBe("just a string");

    const input = Object.assign(new ToolInputError(["Invalid arguments: missing key"]), {
      cause: new Error("schema detail"),
    });
    expect(await rejection(() => throwWithCauses(input))).toBe(input);
  });

  it("skips a cause anything above it already quotes, not just the level right above", () => {
    const chain = (top: string): Error =>
      new Error(top, {
        cause: new Error("No complete answer came back", {
          cause: new Error("fetch failed", {
            cause: new Error("getaddrinfo ENOTFOUND example.invalid"),
          }),
        }),
      });
    expect(
      causeLines(
        chain("No complete answer came back: fetch failed: getaddrinfo ENOTFOUND example.invalid"),
      ),
    ).toEqual([]);
    expect(causeLines(chain("No complete answer came back: fetch failed"))).toEqual([
      "caused by: getaddrinfo ENOTFOUND example.invalid",
    ]);
    const eof = new Error("read failed", { cause: new Error("EOF") });
    expect(causeLines(new Error("Unexpected EOF in config", { cause: eof }))).toEqual([
      "caused by: read failed",
    ]);
  });

  it("matches a cut cause against the full one the message quotes", () => {
    const long = `refused ${"y".repeat(400)}`;
    expect(causeLines(new Error(`top: ${long}`, { cause: new Error(long) }))).toEqual([]);
    expect(causeLines(new Error("top", { cause: new Error(long) }))).toEqual([
      `caused by: refused ${"y".repeat(292)}...`,
    ]);
    const redacted = new Error(`refused apiKey="${"s".repeat(1300)}"`);
    expect(causeLines(new Error("refused by peer", { cause: redacted }))).toEqual([
      "caused by: refused ...",
    ]);
  });
});

describe("progress", () => {
  it("cleans each line and goes quiet once the call settles", async () => {
    const lines: string[] = [];
    const result = await invokeTool(slow, {}, { progress: (message) => lines.push(message) });
    leftover?.("too late");

    expect(resultText(result)).toBe("progress on");
    expect(lines).toEqual(["warming up", "halfway", "backwards", "lost", "almost"]);
  });

  it("keeps the answer when the host throws on an update", async () => {
    const result = await invokeTool(
      slow,
      {},
      {
        progress: () => {
          throw new Error("renderer gone");
        },
      },
    );
    expect(resultText(result)).toBe("progress on");
  });

  it("is absent when nobody listens", async () => {
    expect(resultText(await invokeTool(slow, {}))).toBe("progress off");
  });
});

let seenHost: unknown;
/* Keeps the host context it was handed, so a test can check what each surface passed. */
const peek = defineTool({
  name: "demo_peek",
  title: "Demo Peek",
  description: "Look at the host context.",
  effect: "read",
  input: Type.Object({}),
  execute(_input, { host, progress }): ToolResult<null> {
    seenHost = host;
    progress?.("looking");
    return {
      content: [{ type: "text", text: `host ${host === undefined ? "off" : "on"}` }],
      details: null,
    };
  },
});

describe("host context", () => {
  const ctx = { modelRegistry: {}, sessionManager: { getSessionId: () => "session-1" } };

  it("hands Pi's ctx to execute, with progress or without", async () => {
    const registered: PiToolDefinition[] = [];
    const pi = { registerTool: (definition: PiToolDefinition) => registered.push(definition) };
    registerPiTools(pi as unknown as PiExtensionAPI, [peek]);
    const [tool] = registered;
    if (!tool) throw new Error("nothing registered");

    seenHost = undefined;
    await tool.execute("call-1", {}, undefined, undefined, ctx as never);
    expect(seenHost).toBe(ctx);
    seenHost = undefined;
    await tool.execute("call-2", {}, undefined, () => {}, ctx as never);
    expect(seenHost).toBe(ctx);
  });

  it("hands OMP's ctx to execute, with progress or without", async () => {
    const registered: OmpToolDefinition[] = [];
    const pi = {
      typebox: { Type: { Unsafe: (document: unknown) => document } },
      registerTool: (definition: OmpToolDefinition) => registered.push(definition),
    };
    registerOmpTools(pi as unknown as ExtensionAPI, [peek], {
      Text: class {} as unknown as OmpToolOptions["Text"],
    });
    const [tool] = registered;
    if (!tool) throw new Error("nothing registered");

    seenHost = undefined;
    await tool.execute("call-1", {}, undefined, undefined, ctx as never);
    expect(seenHost).toBe(ctx);
    seenHost = undefined;
    await tool.execute("call-2", {}, undefined, () => {}, ctx as never);
    expect(seenHost).toBe(ctx);
  });

  it("stays out of a host call without a ctx, MCP and the AI SDK", async () => {
    const registered: PiToolDefinition[] = [];
    const pi = { registerTool: (definition: PiToolDefinition) => registered.push(definition) };
    registerPiTools(pi as unknown as PiExtensionAPI, [peek]);
    const answers = [
      await registered[0]?.execute("call-1", {}, undefined, undefined, undefined as never),
      await callTool({ name: "demo" }, [peek], "demo_peek"),
      await toAiTool(peek).execute?.({}, { toolCallId: "1", messages: [], context: {} }),
    ];
    expect(JSON.stringify(answers)).not.toContain("host on");
    expect(JSON.stringify(answers).match(/host off/g)).toHaveLength(3);
  });
});

/* A Streamable HTTP client whose every request carries `x-session`, on whatever serves `fetch`. */
async function sessionClient(serve: (request: Request) => Promise<Response>): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
    fetch: async (input, init) => await serve(new Request(input, init)),
    requestInit: { headers: { "x-session": "ses_header" } },
  });
  const client = new Client({ name: "test", version: "0.0.0" });
  open.push(client);
  await client.connect(transport);
  return client;
}

/* A `demo_peek` call with a harness key in `_meta`, the way opencode tags its calls. */
const TAGGED = { "ai.opencode/sessionID": "ses_meta" };
const taggedPeek = { name: "demo_peek", arguments: {}, _meta: TAGGED };

/* What `demo_peek` found in `host` on its last call. */
function peeked(): McpHost | undefined {
  return seenHost as McpHost | undefined;
}

describe("host context over MCP", () => {
  it("hands the HTTP request and the call's _meta to a tool behind createMcpServer", async () => {
    const handler = createMcpHandler(() =>
      createMcpServer({ name: "demo", version: "0.0.0" }, [peek]),
    );
    const client = await sessionClient(async (request) => await handler.fetch(request));
    await client.callTool(taggedPeek);
    const host = peeked();

    expect(host?.mcp).toBe(true);
    expect(host?.request?.headers.get("x-session")).toBe("ses_header");
    expect(host?.request?.url).toBe("http://localhost/mcp");
    expect(host?.meta).toEqual(TAGGED);
  });

  it("hands the event's request and the call's _meta to a tool behind toH3Tools", async () => {
    const tools = toH3Tools({ name: "demo" }, [peek]);
    const app = new H3().all("/mcp", defineMcpHandler({ name: "demo", version: "0.0.0", tools }));
    const client = await sessionClient(async (request) => await app.fetch(request));
    await client.callTool(taggedPeek);
    const host = peeked();

    expect(host?.mcp).toBe(true);
    expect(host?.request?.headers.get("x-session")).toBe("ses_header");
    expect(host?.meta).toMatchObject(TAGGED);
  });

  it("finds no request off HTTP, and no host at all once the call has no _meta", async () => {
    const client = await mcpClient([peek]);

    await client.callTool(taggedPeek);
    expect(peeked()).toEqual({ mcp: true, meta: TAGGED });
    seenHost = "untouched";
    await client.callTool({ name: "demo_peek", arguments: {} });
    expect(seenHost).toBeUndefined();
  });

  it("rebuilds the request for a tool behind toToolkitTools from SDK v1's requestInfo", async () => {
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => "ses_transport",
    });
    const server = toolkitServer([peek]);
    open.push(server);
    await server.connect(transport);
    const client = new SdkV1Client({ name: "test", version: "0.0.0" });
    open.push(client);
    await client.connect(
      new SdkV1HttpClientTransport(new URL("http://localhost/mcp"), {
        fetch: async (input, init) => await transport.handleRequest(new Request(input, init)),
        requestInit: { headers: { "x-session": "ses_header" } },
      }),
    );
    await client.callTool(taggedPeek);
    const host = peeked();

    expect(host?.mcp).toBe(true);
    expect(host?.request?.headers.get("x-session")).toBe("ses_header");
    expect(host?.request?.url).toBe("http://localhost/mcp");
    expect(host?.request?.body).toBeNull();
    expect(host?.meta).toEqual(TAGGED);
  });

  it("joins a repeated header, skips a name Headers refuses, and needs a usable URL", async () => {
    const [tool] = toToolkitTools({ name: "demo" }, [peek]);
    const headers = { accept: ["a/b", "c/d"], ":path": "/mcp", "x-gone": undefined, "x-ok": "1" };

    await tool?.handler({}, { requestInfo: { headers, url: new URL("http://localhost/mcp") } });
    expect([...(peeked()?.request?.headers ?? [])]).toEqual([
      ["accept", "a/b, c/d"],
      ["x-ok", "1"],
    ]);
    seenHost = "untouched";
    await tool?.handler({}, { requestInfo: { headers } });
    expect(seenHost).toBeUndefined();
    seenHost = "untouched";
    await tool?.handler({}, { requestInfo: { headers, url: new URL("http://u:p@localhost/") } });
    expect(seenHost).toBeUndefined();
  });

  it("hands the toolkit's _meta over too, and no host for a call without one", async () => {
    const client = await toolkitClient(toolkitServer([peek]));

    await client.callTool(taggedPeek);
    expect(peeked()).toEqual({ mcp: true, meta: TAGGED });
    seenHost = "untouched";
    await client.callTool({ name: "demo_peek", arguments: {} });
    expect(seenHost).toBeUndefined();
  });
});

let parked: PromiseWithResolvers<ToolResult<null>> | undefined;
let parkedContext: ToolCallContext | undefined;
/* Never looks at its signal and answers only when the test settles `parked`. */
function parking(effect: ToolEffect): ToolDefinition {
  return defineTool({
    name: `demo_park_${effect}`,
    title: "Demo Park",
    description: "Wait until the test answers.",
    effect,
    input: Type.Object({}),
    async execute(_input, context): Promise<ToolResult<null>> {
      parkedContext = context;
      parked = Promise.withResolvers();
      return await parked.promise;
    },
  });
}

/* The call's error, "answered", or "pending" when it is still waiting a moment later. */
async function outcome(call: () => Promise<unknown>): Promise<unknown> {
  const later = new Promise<string>((resolve) => setTimeout(resolve, 100, "pending"));
  return await Promise.race([
    call().then(
      () => "answered",
      (error: unknown) => error,
    ),
    later,
  ]);
}

describe("cancelling", () => {
  const done: ToolResult<null> = { content: [{ type: "text", text: "done" }], details: null };

  it("lets a read go the moment its signal aborts", async () => {
    const cancel = new AbortController();
    const call = invokeTool(parking("read"), {}, { signal: cancel.signal });
    cancel.abort();

    expect(await outcome(() => call)).toMatchObject({ name: "AbortError" });
    parked?.resolve(done);
  });

  it("never starts a read that arrives cancelled", async () => {
    parked = undefined;
    const call = invokeTool(parking("read"), {}, { signal: AbortSignal.abort() });

    expect(await outcome(() => call)).toMatchObject({ name: "AbortError" });
    expect(parked).toBeUndefined();
  });

  it("swallows a failure that lands after the cancel, and its progress", async () => {
    const lines: string[] = [];
    const cancel = new AbortController();
    const call = invokeTool(
      parking("read"),
      {},
      { signal: cancel.signal, progress: (message) => lines.push(message) },
    );
    cancel.abort();

    expect(await outcome(() => call)).toMatchObject({ name: "AbortError" });
    parkedContext?.progress?.("too late");
    parked?.reject(new Error("socket hang up"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(lines).toEqual([]);
  });

  it.each(["write", "destructive", "exec"] as const)(
    "waits out a cancelled %s, since the host may already have it",
    async (effect) => {
      const cancel = new AbortController();
      const call = invokeTool(parking(effect), {}, { signal: cancel.signal });
      cancel.abort();

      expect(await outcome(() => call)).toBe("pending");
      parked?.resolve(done);
      expect(resultText(await call)).toBe("done");
    },
  );

  it.each(["write", "destructive", "exec"] as const)(
    "never starts a %s that arrives cancelled",
    async (effect) => {
      parked = undefined;
      const call = invokeTool(parking(effect), {}, { signal: AbortSignal.abort() });

      expect(await outcome(() => call)).toMatchObject({ name: "AbortError" });
      expect(parked).toBeUndefined();
    },
  );

  it("drops a write cancelled while its executors are still loading", async () => {
    const importing = Promise.withResolvers<{ readonly write: () => void }>();
    const loadOperations = lazy(async () => await importing.promise);
    const writes: string[] = [];
    const tool = defineTool({
      name: "demo_config_write",
      title: "Write Config",
      description: "Write the config.",
      effect: "write",
      input: Type.Object({}),
      async execute(_input, { signal }): Promise<ToolResult<null>> {
        (await loadOperations(signal)).write();
        return done;
      },
    });
    const cancel = new AbortController();

    const call = invokeTool(tool, {}, { signal: cancel.signal });
    cancel.abort();
    importing.resolve({ write: () => writes.push("config") });

    await expect(call).rejects.toMatchObject({ name: "AbortError" });
    expect(writes).toEqual([]);
  });

  it.each(["Pi", "OMP"])("lets %s go when Esc cancels a read", async (host) => {
    const registered: Array<PiToolDefinition | OmpToolDefinition> = [];
    const register = (definition: PiToolDefinition | OmpToolDefinition): number =>
      registered.push(definition);
    if (host === "Pi") {
      registerPiTools({ registerTool: register } as unknown as PiExtensionAPI, [parking("read")]);
    } else {
      const pi = { typebox: { Type: { Unsafe: (document: unknown) => document } } };
      registerOmpTools(
        { ...pi, registerTool: register } as unknown as ExtensionAPI,
        [parking("read")],
        {
          Text: class {} as unknown as OmpToolOptions["Text"],
        },
      );
    }
    const [tool] = registered;
    if (!tool) throw new Error("nothing registered");
    const cancel = new AbortController();

    const call = tool.execute("call-1", {}, cancel.signal, undefined, {} as never);
    cancel.abort();

    expect(await outcome(() => call)).toMatchObject({ name: "AbortError" });
    parked?.resolve(done);
  });
});

describe("lazy", () => {
  it("loads once for calls that overlap", async () => {
    const load = vi.fn(async () => await Promise.resolve({ ready: true }));
    const operations = lazy(load);

    const [first, second] = await Promise.all([operations(), operations()]);

    expect(load).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
  });

  it("loads again after a failed load", async () => {
    const load = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("disk hiccup"))
      .mockResolvedValueOnce("loaded");
    const operations = lazy(load);

    await expect(operations()).rejects.toThrow("disk hiccup");
    expect(await operations()).toBe("loaded");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("refuses a call cancelled during the load and keeps the module for the next", async () => {
    const importing = Promise.withResolvers<string>();
    const load = vi.fn(async () => await importing.promise);
    const operations = lazy(load);
    const cancel = new AbortController();

    const cancelled = operations(cancel.signal);
    cancel.abort(new Error("Esc"));
    importing.resolve("loaded");

    await expect(cancelled).rejects.toThrow("Esc");
    expect(await operations(new AbortController().signal)).toBe("loaded");
    expect(load).toHaveBeenCalledTimes(1);
  });
});

const open: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((connection) => connection.close()));
});

async function mcpClient(tools: readonly ToolDefinition[] = [echo, slow, count]): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer({ name: "demo", version: "0.0.0" }, tools);
  const client = new Client({ name: "test", version: "0.0.0" });
  open.push(client, server);
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

describe("MCP adapter", () => {
  it("lists the schema verbatim with the title and annotations from the effect", async () => {
    const client = await mcpClient();
    const [tool] = (await client.listTools()).tools;

    expect(tool?.inputSchema).toEqual(JSON.parse(JSON.stringify(echo.input)));
    expect(tool?.title).toBe(echo.title);
    expect(tool?.annotations).toEqual({
      title: echo.title,
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
  });

  it("calls a tool that starts processes destructive", async () => {
    const client = await mcpClient([{ ...echo, effect: "exec" }]);
    const [tool] = (await client.listTools()).tools;

    expect(tool?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
    });
  });

  it("hands the client the title, description, icons and website from the server info", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer(
      {
        name: "demo",
        version: "0.0.0",
        title: "Demo",
        description: "Echoes words for tests.",
        icons: [icon],
        websiteUrl: "https://demo.example",
      },
      [echo],
    );
    const client = new Client({ name: "test", version: "0.0.0" });
    open.push(client, server);
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    expect(client.getServerVersion()).toEqual({
      name: "demo",
      version: "0.0.0",
      title: "Demo",
      description: "Echoes words for tests.",
      icons: [icon],
      websiteUrl: "https://demo.example",
    });
    expect((await client.callTool({ name: "nope", arguments: {} })).content).toEqual([
      { type: "text", text: 'Unknown demo tool: "nope"' },
    ]);
  });

  it("lists a tool's icons and leaves the key out for a tool without them", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer({ name: "demo", version: "0.0.0" }, [echo, signal]);
    const client = new Client({ name: "test", version: "0.0.0" });
    open.push(client, server);
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const [plain, drawn] = (await client.listTools()).tools;

    expect(plain).not.toHaveProperty("icons");
    expect(drawn?.icons).toEqual(signal.icons);
  });

  it("passes success, returned failure, validation failure and thrown failure", async () => {
    const client = await mcpClient();
    const call = (args: Readonly<Record<string, unknown>>) =>
      client.callTool({ name: "demo_echo", arguments: args });

    expect(await call({ word: "hi", mode: "loud" })).toMatchObject({ content: [{ text: "HI" }] });
    expect(await call({ word: "fail" })).toMatchObject({
      isError: true,
      content: [{ text: "cannot echo fail" }],
    });
    expect(await call({ word: "a.b" })).toMatchObject({ isError: true });
    expect(await call({ word: "boom" })).toEqual({
      isError: true,
      content: [{ type: "text", text: "demo_echo failed: exploded FAKE LINE" }],
    });
  });

  it("keeps one line per validation failure and folds a newline inside a value", async () => {
    const client = await mcpClient();
    const answer = await client.callTool({
      name: "demo_echo",
      arguments: { word: "hi", mode: "x", "bad\nkey": 1 },
    });

    expect(answer).toEqual({
      isError: true,
      content: [
        {
          type: "text",
          text: [
            'Invalid arguments: unknown property "bad\\nkey"; takes word, mode',
            "Invalid arguments at /mode: must be one of plain, loud",
          ].join("\n"),
        },
      ],
    });
  });

  describe("a thrown error with causes", () => {
    const thrower = (error: unknown): ToolDefinition =>
      defineTool({
        name: "demo_fallback",
        title: "Demo Fallback",
        description: "Fail through a chain of causes.",
        effect: "read",
        input: Type.Object({}),
        execute(): ToolResult<null> {
          throw error;
        },
      });
    const answer = async (error: unknown): Promise<string | undefined> =>
      firstText(await callTool({ name: "demo" }, [thrower(error)], "demo_fallback"));

    it("reads each cause on its own line, outermost first", async () => {
      const first = new Error("HTTP 502 from haskoin");
      const second = new Error("Rate limited by blockchair", { cause: first });
      expect(await answer(second)).toBe(
        "demo_fallback failed: Rate limited by blockchair\ncaused by: HTTP 502 from haskoin",
      );
    });

    it("stops on a cycle and after five levels", async () => {
      const a = new Error("a");
      const b = new Error("b", { cause: a });
      a.cause = b;
      expect(await answer(b)).toBe("demo_fallback failed: b\ncaused by: a");

      let deep = new Error("level 0");
      for (let level = 1; level <= 8; level += 1)
        deep = new Error(`level ${level}`, { cause: deep });
      expect((await answer(deep))?.split("\n")).toEqual([
        "demo_fallback failed: level 8",
        ...[7, 6, 5, 4, 3].map((level) => `caused by: level ${level}`),
      ]);
    });

    it("redacts what a cause quotes and keeps each cause on one short line", async () => {
      const quoted = [
        "HTTP 502 from https://mainnet.infura.io/v3/s3cret: Bad Gateway",
        "Request cannot be constructed from a URL that includes credentials: https://user:pw@api.example.com/?apikey=s3cret",
        `Unexpected token 'c', "cfk_s3cret" is not valid JSON`,
        "upstream said Authorization=s3cret, page=2",
        "Cookie: theme=dark; sid=s3cret",
        "GET https://user:first@s3cret@api.example.com/v3 failed",
        "GET https://api.example.com/v3?token='s3cret' failed",
        "GET https://api.example.com/v3?token=prefix@s3cret failed",
        "GET https://user:s3 cret@api.example.com failed",
        "GET https://api.example.com/v3?authorization=Bearer s3cret failed",
        "HTTP 502 from https://api.example.com: Bad Gateway",
        `GET "https://user:a'b"c\\d@api.example.com/v3" failed`,
        `refused apiKey="${"s".repeat(1300)}"`,
        `refused https://user:${"p".repeat(1300)}@api.example.com/v3`,
        "no response from http://localhost:3000, retrying",
        `apiKey="s3cret" was refused`,
        "Authorization: Bearer s3cret",
        `{"token":"s3 \\"cret","page":2}`,
        "Invalid key: must be 64 hex digits",
      ];
      const lines = await Promise.all(
        quoted.map(
          async (message) =>
            (await answer(new Error("top", { cause: new Error(message) })))?.split("\n")[1],
        ),
      );
      expect(lines).toEqual([
        "caused by: HTTP 502 from https://mainnet.infura.io/REDACTED",
        "caused by: Request cannot be constructed from a URL that includes credentials: https://REDACTED",
        "caused by: Unexpected token 'c', input is not valid JSON",
        "caused by: upstream said Authorization=REDACTED",
        "caused by: Cookie: REDACTED",
        "caused by: GET https://REDACTED",
        "caused by: GET https://api.example.com/REDACTED",
        "caused by: GET https://REDACTED",
        "caused by: GET https://REDACTED",
        "caused by: GET https://api.example.com/REDACTED",
        "caused by: HTTP 502 from https://api.example.com: Bad Gateway",
        `caused by: GET "https://REDACTED`,
        "caused by: refused ...",
        "caused by: refused ...",
        "caused by: no response from http://localhost:3000, retrying",
        "caused by: apiKey=REDACTED",
        "caused by: Authorization: REDACTED",
        `caused by: {"token":REDACTED`,
        "caused by: Invalid key: must be 64 hex digits",
      ]);

      const long = await answer(new Error("top", { cause: new Error(`x\n${"y".repeat(400)}`) }));
      expect(long?.split("\n")[1]).toBe(`caused by: x ${"y".repeat(298)}...`);
    });

    it("answers the shared fallback with the line every other host shows", async () => {
      expect(firstText(await callTool({ name: "demo" }, [fallback], "demo_fallback"))).toBe(
        `demo_fallback failed: Rate limited by b\n${CAUSE_LINE}`,
      );
    });

    it("reads through what fetch throws: an empty AggregateError, then the attempt", async () => {
      const attempt = Object.assign(new Error("connect ECONNREFUSED ::1:3000"), {
        code: "ECONNREFUSED",
      });
      const refused = new AggregateError([attempt], "");
      expect(await answer(new TypeError("fetch failed", { cause: refused }))).toBe(
        "demo_fallback failed: fetch failed\ncaused by: connect ECONNREFUSED ::1:3000",
      );
    });

    it("skips a cause the message above already quotes, and answers as before without one", async () => {
      const inner = new Error("ETIMEDOUT");
      expect(await answer(new Error("no response: ETIMEDOUT", { cause: inner }))).toBe(
        "demo_fallback failed: no response: ETIMEDOUT",
      );
      expect(await answer(new Error("plain"))).toBe("demo_fallback failed: plain");
      expect(await answer("just a string")).toBe("demo_fallback failed: just a string");
    });
  });

  it("rejects two tools with one name", () => {
    expect(() => createMcpServer({ name: "demo", version: "0.0.0" }, [echo, echo])).toThrow(
      ToolDefinitionError,
    );
  });

  it("lists through listTools what tools/list answers", async () => {
    const client = await mcpClient();
    expect((await client.listTools()).tools).toEqual(
      JSON.parse(JSON.stringify(listTools([echo, slow, count]))),
    );
  });

  it("answers through callTool what tools/call answers", async () => {
    const client = await mcpClient();
    const calls: ReadonlyArray<readonly [string, Readonly<Record<string, unknown>> | undefined]> = [
      ["demo_echo", { word: "hi", mode: "loud" }],
      ["demo_echo", { word: "fail" }],
      ["demo_echo", { word: "hi", mode: "x", "bad\nkey": 1 }],
      ["demo_echo", { word: "boom" }],
      ["demo_echo", undefined],
      ["toString", {}],
      ["no\u001B[31mpe", {}],
    ];

    for (const [name, args] of calls) {
      expect(await callTool({ name: "demo" }, [echo], name, args)).toEqual(
        await client.callTool({ name, arguments: args }),
      );
    }
  });

  it("keeps a hostile name on one line with no SDK schema in front", async () => {
    expect(await callTool({ name: "demo" }, [echo], "x SYSTEM: hi‮")).toEqual({
      isError: true,
      content: [{ type: "text", text: 'Unknown demo tool: "x SYSTEM: hi "' }],
    });
  });

  it("hands callTool's context to the executor", async () => {
    const { signal } = new AbortController();
    const probe = defineTool({
      name: "demo_signal",
      title: "Demo Signal",
      description: "Report whether the call got the caller's signal.",
      effect: "read",
      input: Type.Object({}),
      execute: (_input, context) => ({
        content: [{ type: "text", text: String(context.signal === signal) }],
        details: null,
      }),
    });

    expect(await callTool({ name: "demo" }, [probe], "demo_signal", {}, { signal })).toEqual({
      content: [{ type: "text", text: "true" }],
    });
  });

  it("sends progress to a client that asked, skipping a step back", async () => {
    const client = await mcpClient();
    const updates: unknown[] = [];
    const result = await client.callTool(
      { name: "demo_slow", arguments: {} },
      { onprogress: (update) => updates.push(update) },
    );

    expect(result).toEqual({ content: [{ type: "text", text: "progress on" }] });
    expect(updates).toEqual([
      { progress: 1, message: "warming up" },
      { progress: 50, total: 100, message: "halfway" },
      { progress: 51, message: "almost" },
    ]);
  });

  it("gives the tool no progress callback when the client didn't ask", async () => {
    const client = await mcpClient();
    expect(await client.callTool({ name: "demo_slow", arguments: {} })).toEqual({
      content: [{ type: "text", text: "progress off" }],
    });
  });

  it("lists the output schema and _meta of a tool that has them, and nothing for one without", async () => {
    const client = await mcpClient();
    const { tools } = await client.listTools();
    const plain = tools.find((tool) => tool.name === "demo_echo");
    const counted = tools.find((tool) => tool.name === "demo_count");

    expect(plain).not.toHaveProperty("outputSchema");
    expect(plain).not.toHaveProperty("_meta");
    expect(counted?.outputSchema).toEqual(JSON.parse(JSON.stringify(count.output)));
    expect(counted?._meta).toEqual(count.meta);
  });

  it("sends checked details as structuredContent, never on a failure", async () => {
    const client = await mcpClient();
    const call = async (word: string) =>
      client.callTool({ name: "demo_count", arguments: { word } });

    expect(await call("hey")).toEqual({
      content: [{ type: "text", text: "hey has 3 letters" }],
      structuredContent: { word: "hey", letters: 3 },
    });
    expect(await call("fail")).toEqual({
      content: [{ type: "text", text: "cannot count fail" }],
      isError: true,
    });
    expect(await call("drift")).toEqual({
      content: [
        {
          type: "text",
          text: "demo_count returned details that don't match its output schema\nat /letters: must be integer",
        },
      ],
      isError: true,
    });
    expect(
      await client.callTool({ name: "demo_echo", arguments: { word: "hi" } }),
    ).not.toHaveProperty("structuredContent");
  });

  it("answers a tool with output through callTool as tools/call does", async () => {
    const client = await mcpClient();
    for (const word of ["hey", "fail", "drift"]) {
      expect(await callTool({ name: "demo" }, [count], "demo_count", { word })).toEqual(
        await client.callTool({ name: "demo_count", arguments: { word } }),
      );
    }
  });

  it("treats prototype names as unknown tools", async () => {
    const client = await mcpClient();
    expect(await client.callTool({ name: "toString", arguments: {} })).toEqual({
      isError: true,
      content: [{ type: "text", text: 'Unknown demo tool: "toString"' }],
    });
  });
});

const signal = defineTool({
  name: "demo_signal",
  title: "Demo Signal",
  description: "Report whether the call has an abort signal.",
  icons: [icon, { src: "https://demo.example/signal-dark.png", sizes: ["48x48"], theme: "dark" }],
  effect: "read",
  input: Type.Object({}),
  execute: (_input, context) => ({
    content: [{ type: "text", text: String(context.signal instanceof AbortSignal) }],
    details: null,
  }),
});

/**
 * A real SDK client talking Streamable HTTP to an h3-mcp handler, through `app.fetch`.
 *
 * @returns {Promise<Client>} Connected client.
 */
async function h3Client(): Promise<Client> {
  const app = new H3().all(
    "/mcp",
    defineMcpHandler({
      name: "demo",
      version: "0.0.0",
      tools: toH3Tools({ name: "demo" }, [echo, slow, signal, count]),
    }),
  );
  const transport = new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
    fetch: async (input, init) => app.fetch(new Request(input, init)),
  });
  const client = new Client({ name: "test", version: "0.0.0" });
  open.push(client);
  await client.connect(transport);
  return client;
}

describe("h3-mcp adapter", () => {
  it("lists over h3-mcp what tools/list answers", async () => {
    const client = await h3Client();
    expect((await client.listTools()).tools).toEqual(
      JSON.parse(JSON.stringify(listTools([echo, slow, signal, count]))),
    );
  });

  it("answers every known tool as the MCP server does", async () => {
    const [h3, sdk] = await Promise.all([h3Client(), mcpClient()]);
    const calls: ReadonlyArray<Readonly<Record<string, unknown>> | undefined> = [
      { word: "hi", mode: "loud" },
      { word: "fail" },
      { word: "hi", mode: "x", "bad\nkey": 1 },
      { word: "boom" },
      undefined,
    ];

    for (const args of calls) {
      const call = { name: "demo_echo", arguments: args };
      expect(await h3.callTool(call)).toEqual(await sdk.callTool(call));
    }
  });

  it("leaves an unknown name to h3-mcp's own JSON-RPC error", async () => {
    const client = await h3Client();
    await expect(client.callTool({ name: "toString", arguments: {} })).rejects.toThrow(
      "Tool not found",
    );
  });

  it("sends progress to a client that asked, numbered as the MCP server numbers it", async () => {
    const client = await h3Client();
    const updates: unknown[] = [];
    const result = await client.callTool(
      { name: "demo_slow", arguments: {} },
      { onprogress: (update) => updates.push(update) },
    );

    expect(result).toEqual({ content: [{ type: "text", text: "progress on" }] });
    expect(updates).toEqual([
      { progress: 1, message: "warming up" },
      { progress: 50, total: 100, message: "halfway" },
      { progress: 51, message: "almost" },
    ]);
  });

  it("gives the tool no progress callback when the client didn't ask", async () => {
    const client = await h3Client();
    expect(await client.callTool({ name: "demo_slow", arguments: {} })).toEqual({
      content: [{ type: "text", text: "progress off" }],
    });
  });

  it("answers a tool with output as the MCP server does", async () => {
    const [h3, sdk] = await Promise.all([h3Client(), mcpClient()]);
    for (const word of ["hey", "fail", "drift"]) {
      const call = { name: "demo_count", arguments: { word } };
      expect(await h3.callTool(call)).toEqual(await sdk.callTool(call));
    }
  });

  it("hands the request's abort signal to the executor", async () => {
    const client = await h3Client();
    expect(await client.callTool({ name: "demo_signal", arguments: {} })).toEqual({
      content: [{ type: "text", text: "true" }],
    });
  });
});

/**
 * An `McpServer` that registers each entry the way the toolkit does.
 *
 * The toolkit's own module needs Nitro, so this repeats its `registerToolFromDefinition` call.
 * Bare SDK v1 types the result tighter than the toolkit does, hence the cast.
 *
 * @param tools - Tools to serve.
 * @param elicitation - Whether to pass a `useMcpElicitation` reading the server, like the real one.
 * @returns {McpServer} Unconnected server.
 */
function toolkitServer(tools: readonly ToolDefinition[], elicitation = false): McpServer {
  const server = new McpServer({ name: "demo", version: "0.0.0" });
  const options = elicitation
    ? { elicitation: () => ({ supports: () => canAsk(server.server.getClientCapabilities()) }) }
    : {};
  for (const tool of toToolkitTools({ name: "demo" }, tools, options)) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema as AnySchema,
        outputSchema: tool.outputSchema as AnySchema | undefined,
        annotations: tool.annotations,
        _meta: { ...tool._meta },
      },
      async (args: unknown, extra: ToolkitExtra) =>
        (await tool.handler(args, extra)) as SdkV1Result,
    );
  }
  return server;
}

/**
 * Connects an SDK v1 client to a toolkit server.
 *
 * @param server - Server from `toolkitServer`.
 * @param client - Client to connect, a plain one when left out.
 * @returns {Promise<SdkV1Client>} Connected client.
 */
async function toolkitClient(
  server = toolkitServer([echo, slow, signal, count]),
  client = new SdkV1Client({ name: "test", version: "0.0.0" }),
): Promise<SdkV1Client> {
  const [clientTransport, serverTransport] = SdkV1Transport.createLinkedPair();
  open.push(client, server);
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

describe("mcp-toolkit adapter", () => {
  it("lists what tools/list answers, plus what the toolkit and SDK v1 add on their own", async () => {
    const client = await toolkitClient();
    const draft7 = { $schema: "http://json-schema.org/draft-07/schema#" };
    const expected = listTools([echo, slow, signal, count]).map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: { ...draft7, ...tool.inputSchema },
      ...(tool.outputSchema === undefined
        ? {}
        : { outputSchema: { ...draft7, ...tool.outputSchema } }),
      annotations: tool.annotations,
      execution: { taskSupport: "forbidden" },
      _meta: tool._meta ?? {},
    }));
    expect((await client.listTools()).tools).toEqual(JSON.parse(JSON.stringify(expected)));
  });

  it("answers every known tool as the MCP server does, a missing arguments included", async () => {
    const [toolkit, sdk] = await Promise.all([toolkitClient(), mcpClient()]);
    const calls: ReadonlyArray<Readonly<Record<string, unknown>> | undefined> = [
      { word: "hi", mode: "loud" },
      { word: "fail" },
      { word: "hi", mode: "x", "bad\nkey": 1 },
      { word: "boom" },
      JSON.parse('{"word":"hi","__proto__":{"mode":"loud"}}') as Readonly<Record<string, unknown>>,
      undefined,
    ];

    for (const args of calls) {
      const call = { name: "demo_echo", arguments: args };
      expect(await toolkit.callTool(call)).toEqual(await sdk.callTool(call));
    }
  });

  it("reads a missing arguments as {}, which SDK 1.30 hands Zod as undefined", () => {
    const [schema] = toToolkitTools({ name: "demo" }, [echo]).map(
      (tool) => tool.inputSchema as z.ZodType,
    );
    expect(schema?.safeParse(undefined)).toEqual({
      success: true,
      data: {},
    });
  });

  it("sends progress to a client that asked, numbered as the MCP server numbers it", async () => {
    const client = await toolkitClient();
    const updates: unknown[] = [];
    const result = await client.callTool({ name: "demo_slow", arguments: {} }, undefined, {
      onprogress: (update) => updates.push(update),
    });

    expect(result).toEqual({ content: [{ type: "text", text: "progress on" }] });
    expect(updates).toEqual([
      { progress: 1, message: "warming up" },
      { progress: 50, total: 100, message: "halfway" },
      { progress: 51, message: "almost" },
    ]);
  });

  it("gives the tool no progress callback when the client didn't ask", async () => {
    const client = await toolkitClient();
    expect(await client.callTool({ name: "demo_slow", arguments: {} })).toEqual({
      content: [{ type: "text", text: "progress off" }],
    });
  });

  it("answers a tool with output as the MCP server does, past the SDK's own output check", async () => {
    const [toolkit, sdk] = await Promise.all([toolkitClient(), mcpClient()]);
    for (const word of ["hey", "fail", "drift"]) {
      const call = { name: "demo_count", arguments: { word } };
      expect(await toolkit.callTool(call)).toEqual(await sdk.callTool(call));
    }
  });

  it("hands the request's abort signal to the executor", async () => {
    const client = await toolkitClient();
    expect(await client.callTool({ name: "demo_signal", arguments: {} })).toEqual({
      content: [{ type: "text", text: "true" }],
    });
  });
});

describe("AI SDK adapter", () => {
  /** Just the PNG signature. Nothing here decodes it, so it passes for a picture. */
  const PNG = "iVBORw0KGgo=";
  /** Answers with the caption, when there is one, and a picture. */
  const picture = defineTool({
    name: "demo_picture",
    title: "Picture",
    description: "x",
    effect: "read",
    input: Type.Object({ caption: Type.String() }, { additionalProperties: false }),
    execute: ({ caption }) => ({
      content: [
        ...(caption === "" ? [] : [{ type: "text" as const, text: caption }]),
        { type: "image", data: PNG, mimeType: "image/png" },
      ],
      details: { width: 1 },
    }),
  });

  it("validates through the shared validator and returns details with the text", async () => {
    const tool = toAiTool(echo);
    if (!tool.execute) throw new Error("tool not executable");
    const schema = asSchema(tool.inputSchema);
    const options = { toolCallId: "1", messages: [], context: {} };

    expect(schema.jsonSchema).toEqual(JSON.parse(JSON.stringify(echo.input)));
    expect((await schema.validate?.({ word: "a.b" }))?.success).toBe(false);
    expect(await tool.execute({ word: "hi" }, options)).toEqual({ word: "hi", text: "hi" });
    await expect(tool.execute({ word: "fail" }, options)).rejects.toThrow("cannot echo fail");
    expect(Object.keys(toAiTools([echo]))).toEqual(["demo_echo"]);
  });

  it("keys the tool set by literal names, each tool keeping its types", async () => {
    const tools = toAiTools([echo]);
    const options = { toolCallId: "1", messages: [], context: {} };

    expectTypeOf(tools).toEqualTypeOf<{
      demo_echo: Tool<{ word: string; mode?: "plain" | "loud" }, AiToolOutput<{ word: string }>>;
    }>();
    expect(await tools.demo_echo.execute?.({ word: "hi" }, options)).toEqual({
      word: "hi",
      text: "hi",
    });
    /* @ts-expect-error */
    expect(tools.demo_ech0).toBeUndefined();
    /* @ts-expect-error */
    await expect(tools.demo_echo.execute?.({ word: 42 }, options)).rejects.toThrow();
  });

  it("keys a list built with map by its name union", () => {
    const names = ["demo_one", "demo_two"] as const;
    const built = names.map((name) =>
      defineTool({
        name,
        title: name,
        description: "x",
        effect: "read",
        input: Type.Object({}),
        execute: () => ({ content: [{ type: "text", text: name }], details: {} }),
      }),
    );
    const tools = toAiTools(built);

    expectTypeOf<keyof typeof tools>().toEqualTypeOf<"demo_one" | "demo_two">();
    expect(Object.keys(tools)).toEqual(["demo_one", "demo_two"]);
  });

  it("still takes a plain ToolDefinition list, keyed by string", () => {
    const plain: readonly ToolDefinition[] = [echo];
    expectTypeOf(toAiTools(plain)).toExtend<Record<string, Tool>>();
    expect(Object.keys(toAiTools(plain))).toEqual(["demo_echo"]);
  });

  it("hands the model the text alone, not the details a second time", async () => {
    const usage = {
      inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 1, text: 1, reasoning: undefined },
    };
    const model = new MockLanguageModelV4({
      doGenerate: [
        {
          content: [
            {
              type: "tool-call",
              toolCallId: "1",
              toolName: "demo_echo",
              input: JSON.stringify({ word: "hi", mode: "loud" }),
            },
          ],
          finishReason: { unified: "tool-calls", raw: undefined },
          usage,
          warnings: [],
        },
        {
          content: [{ type: "text", text: "done" }],
          finishReason: { unified: "stop", raw: undefined },
          usage,
          warnings: [],
        },
      ],
    });

    const run = await generateText({
      model,
      prompt: "shout hi",
      tools: toAiTools([echo]),
      stopWhen: isStepCount(2),
    });

    expect(run.steps[0]?.toolResults[0]?.output).toEqual({ word: "hi", text: "HI" });
    expect(model.doGenerateCalls[1]?.prompt.at(-1)).toMatchObject({
      role: "tool",
      content: [{ type: "tool-result", output: { type: "text", value: "HI" } }],
    });
  });

  it("shows the model an image the tool answers with alone, not the details as JSON", async () => {
    const tool = toAiTool(picture);
    const options = { toolCallId: "1", messages: [], context: {} };
    const output = await tool.execute?.({ caption: "" }, options);

    expect(output).toEqual({ width: 1, text: "", images: [{ data: PNG, mimeType: "image/png" }] });
    expect(
      await tool.toModelOutput?.({
        toolCallId: "1",
        input: { caption: "" },
        output: output as never,
      }),
    ).toEqual({
      type: "content",
      value: [{ type: "file", data: { type: "data", data: PNG }, mediaType: "image/png" }],
    });
  });

  it("puts the image in front of the model next to the text", async () => {
    const usage = {
      inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 1, text: 1, reasoning: undefined },
    };
    const model = new MockLanguageModelV4({
      doGenerate: [
        {
          content: [
            {
              type: "tool-call",
              toolCallId: "1",
              toolName: "demo_picture",
              input: JSON.stringify({ caption: "a dot" }),
            },
          ],
          finishReason: { unified: "tool-calls", raw: undefined },
          usage,
          warnings: [],
        },
        {
          content: [{ type: "text", text: "a dot it is" }],
          finishReason: { unified: "stop", raw: undefined },
          usage,
          warnings: [],
        },
      ],
    });

    await generateText({
      model,
      prompt: "draw a dot",
      tools: toAiTools([picture]),
      stopWhen: isStepCount(2),
    });

    expect(model.doGenerateCalls[1]?.prompt.at(-1)).toMatchObject({
      role: "tool",
      content: [
        {
          type: "tool-result",
          output: {
            type: "content",
            value: [
              { type: "text", text: "a dot" },
              { type: "file", data: { type: "data", data: PNG }, mediaType: "image/png" },
            ],
          },
        },
      ],
    });
  });

  it("reads a stored output whose images got mangled as the text alone", async () => {
    const tool = toAiTool(picture);
    const stored = { width: 1, text: "a dot", images: [{ data: 1 }, null, "x"] };

    expect(
      await tool.toModelOutput?.({
        toolCallId: "1",
        input: { caption: "a dot" },
        output: stored as never,
      }),
    ).toEqual({ type: "text", value: "a dot" });
  });

  it("gives the tool no progress callback, since the AI SDK has nowhere to show it", async () => {
    const tool = toAiTool(slow);
    if (!tool.execute) throw new Error("tool not executable");
    expect(await tool.execute({}, { toolCallId: "1", messages: [], context: {} })).toEqual({
      details: null,
      text: "progress off",
    });
  });

  it("throws the cause lines MCP shows, with the thrown error kept as the cause", async () => {
    const tool = toAiTool(fallback);
    if (!tool.execute) throw new Error("tool not executable");
    const options = { toolCallId: "1", messages: [], context: {} };

    const shown = await rejection(async () => await tool.execute?.({}, options));
    expect(shown).toMatchObject({ message: `Rate limited by b\n${CAUSE_LINE}`, name: "Error" });
    expect((shown as Error).cause).toMatchObject({ message: "Rate limited by b" });

    const plain = await rejection(async () => await tool.execute?.({ cause: false }, options));
    expect(plain).toMatchObject({ message: "Rate limited by b" });
    expect((plain as Error).cause).toBeUndefined();
  });

  it.each(["text", "images"])(
    "refuses details with their own %s field instead of overwriting it",
    async (field) => {
      const clash = defineTool({
        name: "demo_clash",
        title: "Clash",
        description: "x",
        effect: "read",
        input: Type.Object({}),
        execute: () => ({
          content: [{ type: "text", text: "shown" }],
          details: { [field]: "slice" },
        }),
      });
      const tool = toAiTool(clash);
      if (!tool.execute) throw new Error("tool not executable");

      await expect(
        tool.execute({}, { toolCallId: "1", messages: [], context: {} }),
      ).rejects.toThrow(`details must not have their own ${field} field`);
    },
  );
});

describe("OMP adapter", () => {
  /* What reaches `pi.registerTool` on a host double, one entry per tool. */
  function register(loadMode?: "essential" | "discoverable"): OmpToolDefinition[] {
    const registered: OmpToolDefinition[] = [];
    const pi = {
      typebox: { Type: { Unsafe: (document: unknown) => document } },
      registerTool: (definition: OmpToolDefinition) => registered.push(definition),
    };
    class Text {
      readonly text: string;
      constructor(text: string) {
        this.text = text;
      }
    }
    registerOmpTools(
      pi as unknown as ExtensionAPI,
      [echo, { ...echo, name: "demo_echo_too" }, slow],
      {
        Text: Text as unknown as OmpToolOptions["Text"],
        loadMode,
      },
    );
    return registered;
  }

  it("leaves the load mode to OMP unless asked", () => {
    expect(register().map((tool) => tool.loadMode)).toEqual([undefined, undefined, undefined]);
  });

  it("puts every tool in the load mode it is given", () => {
    expect(register("essential").map((tool) => tool.loadMode)).toEqual([
      "essential",
      "essential",
      "essential",
    ]);
    expect(register("discoverable").map((tool) => tool.loadMode)).toEqual([
      "discoverable",
      "discoverable",
      "discoverable",
    ]);
  });

  it("keeps optional fields optional on OpenAI models", () => {
    expect(register().map((tool) => tool.strict)).toEqual([false, false, false]);
  });

  it("asks for the approval tier each effect needs and draws it on the badge", () => {
    const registered: OmpToolDefinition[] = [];
    const pi = {
      typebox: { Type: { Unsafe: (document: unknown) => document } },
      registerTool: (definition: OmpToolDefinition) => registered.push(definition),
    };
    class Text {
      readonly text: string;
      constructor(text: string) {
        this.text = text;
      }
    }
    const effects = ["read", "write", "destructive", "exec"] as const;
    registerOmpTools(
      pi as unknown as ExtensionAPI,
      effects.map((effect) => ({ ...echo, name: `demo_${effect}`, effect })),
      { Text: Text as unknown as OmpToolOptions["Text"] },
    );
    const theme = {
      fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
      styledSymbol: (name: string) => `[${name}]`,
      format: { bracketLeft: "[", bracketRight: "]" },
    };
    const badges = registered.map((tool) => {
      const line = tool.renderResult?.(
        { content: [{ type: "text", text: "done" }], details: {} },
        { expanded: false, isPartial: false },
        theme as never,
        {},
      ) as unknown as Text;
      return /\[(?<tier>\w+)\]<\/accent>$/mu.exec(line.text)?.groups?.tier;
    });

    expect(registered.map((tool) => tool.approval)).toEqual(["read", "write", "write", "exec"]);
    expect(badges).toEqual(["read", "write", "write", "exec"]);
  });

  /* The registered `demo_slow`. */
  function slowTool(): OmpToolDefinition {
    const tool = register().find((definition) => definition.name === "demo_slow");
    if (!tool) throw new Error("demo_slow not registered");
    return tool;
  }

  it("streams each progress line through onUpdate as a partial result", async () => {
    const partials: unknown[] = [];
    const result = await slowTool().execute(
      "call-1",
      {},
      undefined,
      (partial) => partials.push(partial),
      {} as never,
    );

    expect(result).toEqual({ content: [{ type: "text", text: "progress on" }], details: null });
    expect(partials).toEqual(
      ["warming up", "halfway", "backwards", "lost", "almost"].map((text) => ({
        content: [{ type: "text", text }],
        details: {},
      })),
    );
  });

  it("throws the cause lines MCP shows, with the thrown error kept as the cause", async () => {
    const registered: OmpToolDefinition[] = [];
    const pi = {
      typebox: { Type: { Unsafe: (document: unknown) => document } },
      registerTool: (definition: OmpToolDefinition) => registered.push(definition),
    };
    registerOmpTools(pi as unknown as ExtensionAPI, [fallback], {
      Text: class {} as unknown as OmpToolOptions["Text"],
    });
    const [tool] = registered;
    if (!tool) throw new Error("demo_fallback not registered");
    const call = async (args: Readonly<Record<string, unknown>>): Promise<unknown> =>
      await rejection(
        async () => await tool.execute("call-1", args, undefined, undefined, {} as never),
      );

    const shown = await call({});
    expect(shown).toMatchObject({ message: `Rate limited by b\n${CAUSE_LINE}`, name: "Error" });
    expect((shown as Error).cause).toMatchObject({ message: "Rate limited by b" });
    expect(await call({ cause: false })).toMatchObject({ message: "Rate limited by b" });
    expect(await call({ cause: "yes" })).toBeInstanceOf(ToolInputError);
  });

  it("lets a renderCall of the same tool win over describeCall", () => {
    const registered: OmpToolDefinition[] = [];
    const pi = {
      typebox: { Type: { Unsafe: (document: unknown) => document } },
      registerTool: (definition: OmpToolDefinition) => registered.push(definition),
    };
    const own = { text: "own" };
    const calls: unknown[][] = [];
    registerOmpTools(pi as unknown as ExtensionAPI, [echo], {
      Text: class {} as unknown as OmpToolOptions["Text"],
      renderers: {
        demo_echo: {
          describeCall: () => "summary",
          renderCall: (...args) => {
            calls.push(args);
            return own as never;
          },
        },
      },
    });
    const options = { expanded: false, isPartial: true };

    expect(registered[0]?.renderCall?.({ word: "hi" }, options, "theme" as never)).toBe(own);
    expect(calls).toEqual([[{ word: "hi" }, options, "theme"]]);
  });

  /* Draws a finished `demo_echo` row the way OMP asks for it. */
  function drawAnswer(text: string, expanded: boolean, isError?: boolean): unknown {
    const theme = {
      fg: (color: string, line: string) => `<${color}>${line}</${color}>`,
      styledSymbol: (name: string) => `[${name}]`,
      format: { bracketLeft: "[", bracketRight: "]" },
      sep: { dot: " · " },
    };
    return register()[0]?.renderResult?.(
      { content: [{ type: "text", text }], details: {}, isError },
      { expanded, isPartial: false },
      theme as never,
      {},
    );
  }
  const status = "[status.done] <accent>Demo Echo</accent> <accent>[read]</accent>";

  it("shows the answer under the status line", () => {
    expect(drawAnswer("hi\u001B[2J\r\nthe\u202Ere\n", false)).toEqual({
      text: `${status}\n<toolOutput>hi</toolOutput>\n<toolOutput>there</toolOutput>`,
    });
  });

  it("shows four lines collapsed, counts the rest and shows all of them expanded", () => {
    const text = ["1", "2", "3", "4", "5", "6"].join("\n");
    const line = (word: string) => `<toolOutput>${word}</toolOutput>`;

    expect(drawAnswer(text, false)).toEqual({
      text: [status, ...["1", "2", "3", "4"].map(line), "<dim>… 2 more lines</dim>"].join("\n"),
    });
    expect(drawAnswer(text, true)).toEqual({
      text: [status, ...["1", "2", "3", "4", "5", "6"].map(line)].join("\n"),
    });
  });

  it("shows the text of an error and keeps a blank answer to the status line", () => {
    expect(drawAnswer("no such word", false, true)).toEqual({
      text: "[status.error] <accent>Demo Echo</accent> <accent>[read]</accent>\n<toolOutput>no such word</toolOutput>",
    });
    expect(drawAnswer(" \n\n", false)).toEqual({ text: status });
  });

  it("keeps the spinner and the last line on a partial result", () => {
    const theme = {
      fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
      styledSymbol: (name: string) => `[${name}]`,
      spinnerFrames: ["-", "\\"],
      format: { bracketLeft: "[", bracketRight: "]" },
      sep: { dot: " · " },
    };
    const draw = (isPartial: boolean): unknown =>
      slowTool().renderResult?.(
        { content: [{ type: "text", text: "halfway\u001B[2J" }], details: {} },
        { expanded: false, isPartial, spinnerFrame: 1 },
        theme as never,
        {},
      );

    expect(draw(true)).toEqual({ text: "\\ <accent>Demo Slow</accent> <dim>halfway</dim>" });
    expect(draw(false)).toEqual({
      text: "[status.done] <accent>Demo Slow</accent> <accent>[read]</accent>\n<toolOutput>halfway</toolOutput>",
    });
  });
});

describe("Pi adapter", () => {
  class Text {
    readonly text: string;
    constructor(text: string) {
      this.text = text;
    }
  }
  /* Marks each style by name, so a test reads which colour a piece got. */
  const theme = {
    fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
    bold: (text: string) => `*${text}*`,
  } as unknown as PiTheme;

  /* What reaches `pi.registerTool` on a host double. */
  function register(options: PiToolOptions): PiToolDefinition {
    const registered: PiToolDefinition[] = [];
    const pi = { registerTool: (definition: PiToolDefinition) => registered.push(definition) };
    registerPiTools(pi as unknown as PiExtensionAPI, [echo], options);
    const [definition] = registered;
    if (!definition) throw new Error("nothing registered");
    return definition;
  }

  /* The text of the call line Pi would draw for these arguments. */
  function callLine(definition: PiToolDefinition, args: Readonly<Record<string, unknown>>): string {
    const line = definition.renderCall?.(args, theme, {} as never);
    if (!(line instanceof Text)) throw new Error("no call line");
    return line.text;
  }

  const pass = Text as unknown as PiToolOptions["Text"];

  it("draws the title and a sanitized describeCall summary", () => {
    const definition = register({
      Text: pass,
      renderers: { demo_echo: { describeCall: (args) => `${String(args.word)}\nFAKE\u001B[31m` } },
    });
    expect(callLine(definition, { word: "hi" })).toBe(
      "<toolTitle>*Demo Echo*</toolTitle> <muted>hi FAKE</muted>",
    );
  });

  it("draws the title alone when the summary is empty", () => {
    const definition = register({
      Text: pass,
      renderers: { demo_echo: { describeCall: () => "" } },
    });
    expect(callLine(definition, {})).toBe("<toolTitle>*Demo Echo*</toolTitle>");
  });

  it("lets a renderCall of the same tool win over describeCall", () => {
    const own = new Text("own");
    const definition = register({
      Text: pass,
      renderers: {
        demo_echo: { describeCall: () => "summary", renderCall: () => own as never },
      },
    });
    expect(definition.renderCall?.({}, theme, {} as never)).toBe(own);
    expect(definition).not.toHaveProperty("describeCall");
  });

  it("keeps a renderResult next to describeCall", () => {
    const renderResult = (): never => new Text("result") as never;
    const definition = register({
      Text: pass,
      renderers: { demo_echo: { describeCall: () => "summary", renderResult } },
    });
    expect(definition.renderResult).toBe(renderResult);
  });

  it("refuses describeCall without the host Text", () => {
    expect(() => register({ renderers: { demo_echo: { describeCall: () => "summary" } } })).toThrow(
      new ToolDefinitionError("demo_echo: describeCall needs the host Text option"),
    );
  });

  it("leaves the call line to Pi without renderers", () => {
    expect(register({})).not.toHaveProperty("renderCall");
  });

  /* A Pi context whose dialog records each question and gives `answer`. */
  function dialog(answer: boolean, hasUI = true) {
    const asked: string[] = [];
    const ctx = {
      hasUI,
      ui: {
        confirm: async (
          title: string,
          message: string,
          opts?: Readonly<{ signal?: AbortSignal }>,
        ) => {
          asked.push(`${title} | ${message} | ${opts?.signal ? "signal" : "no signal"}`);
          return answer;
        },
      },
    };
    return { asked, ctx };
  }

  /* Runs one call of `demo_echo` the way Pi does. */
  async function call(
    options: PiToolOptions,
    args: Readonly<Record<string, unknown>>,
    ctx: object,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return await register(options).execute("call-1", args, signal, undefined, ctx as never);
  }

  const ask: PiToolOptions = {
    confirm: {
      demo_echo: ({ word }) => ({
        title: "Echo?\nFAKE",
        message: `Word\t${String(word)}\r\n\u001B[31mred\u202E\u2028end`,
      }),
    },
  };

  it("asks with the validated input, then runs the call on a yes", async () => {
    const { asked, ctx } = dialog(true);
    const result = await call(ask, { word: "hi" }, ctx, new AbortController().signal);
    expect(asked).toEqual(["Echo? FAKE | Word\thi\nred end | signal"]);
    expect(result).toMatchObject({ content: [{ type: "text", text: "hi" }] });
  });

  it("refuses bad input before asking, with the same issues as without a question", async () => {
    const { asked, ctx } = dialog(true);
    const thrown = await call(ask, { mode: "quiet" }, ctx).catch((error: unknown) => error);
    const plain = await invokeTool(echo, { mode: "quiet" }).catch((error: unknown) => error);
    expect(asked).toEqual([]);
    expect(thrown instanceof ToolInputError ? thrown.issues : "no ToolInputError").toEqual(
      plain instanceof ToolInputError ? plain.issues : [],
    );
  });

  it("refuses on a no without running the call", async () => {
    const { ctx } = dialog(false);
    await expect(call(ask, { word: "boom" }, ctx)).rejects.toThrow(
      "demo_echo was cancelled by the user. Do not retry unless the user asks again.",
    );
  });

  it("refuses without a UI instead of running unasked", async () => {
    const { asked, ctx } = dialog(true, false);
    await expect(call(ask, { word: "boom" }, ctx)).rejects.toThrow(
      "demo_echo needs interactive approval in Pi TUI or RPC mode",
    );
    expect(asked).toEqual([]);
  });

  it("runs without a dialog when the question comes back empty", async () => {
    const { asked, ctx } = dialog(false, false);
    const result = await call({ confirm: { demo_echo: () => undefined } }, { word: "hi" }, ctx);
    expect(asked).toEqual([]);
    expect(result).toMatchObject({ content: [{ type: "text", text: "hi" }] });
  });

  it("rejects bad arguments before anyone is asked", async () => {
    const { asked, ctx } = dialog(true);
    await expect(call(ask, { word: "hi", extra: 1 }, ctx)).rejects.toThrow("unknown property");
    expect(asked).toEqual([]);
  });

  it("reports an abort during the dialog as the abort, not as a no", async () => {
    const controller = new AbortController();
    const ctx = {
      hasUI: true,
      ui: {
        confirm: async () => {
          controller.abort(new Error("call aborted"));
          return false;
        },
      },
    };
    await expect(call(ask, { word: "hi" }, ctx, controller.signal)).rejects.toThrow("call aborted");
  });

  it("throws the cause lines MCP shows, with the thrown error kept as the cause", async () => {
    const registered: PiToolDefinition[] = [];
    const pi = { registerTool: (definition: PiToolDefinition) => registered.push(definition) };
    registerPiTools(pi as unknown as PiExtensionAPI, [fallback]);
    const [tool] = registered;
    if (!tool) throw new Error("demo_fallback not registered");
    const call = async (args: Readonly<Record<string, unknown>>): Promise<unknown> =>
      await rejection(
        async () => await tool.execute("call-1", args, undefined, undefined, {} as never),
      );

    const shown = await call({});
    expect(shown).toMatchObject({ message: `Rate limited by b\n${CAUSE_LINE}`, name: "Error" });
    expect((shown as Error).cause).toMatchObject({ message: "Rate limited by b" });
    expect(await call({ cause: false })).toMatchObject({ message: "Rate limited by b" });
    expect(await call({ cause: "yes" })).toBeInstanceOf(ToolInputError);
  });

  it("streams each progress line through onUpdate, and none without it", async () => {
    const registered: PiToolDefinition[] = [];
    const pi = { registerTool: (definition: PiToolDefinition) => registered.push(definition) };
    registerPiTools(pi as unknown as PiExtensionAPI, [slow]);
    const [tool] = registered;
    if (!tool) throw new Error("nothing registered");
    const partials: unknown[] = [];

    const streamed = await tool.execute(
      "call-1",
      {},
      undefined,
      (partial) => partials.push(partial),
      {} as never,
    );
    const quiet = await tool.execute("call-2", {}, undefined, undefined, {} as never);

    expect(streamed.content).toEqual([{ type: "text", text: "progress on" }]);
    expect(quiet.content).toEqual([{ type: "text", text: "progress off" }]);
    expect(partials).toEqual(
      ["warming up", "halfway", "backwards", "lost", "almost"].map((text) => ({
        content: [{ type: "text", text }],
        details: {},
      })),
    );
  });

  it("refuses a question for a tool that isn't in the list", () => {
    expect(() => register({ confirm: { demo_ecko: () => undefined } })).toThrow(
      new ToolDefinitionError('confirm names "demo_ecko", which isn\'t in the tool list'),
    );
  });

  /* Takes one id or a list, like harnesses_info, and says which one it got. */
  const lookup = defineTool({
    name: "demo_lookup",
    title: "Demo Lookup",
    description: "Look up one id or several.",
    effect: "read",
    input: Type.Object(
      { id: Type.Union([Type.String(), Type.Array(Type.String())]) },
      { additionalProperties: false },
    ),
    execute: ({ id }): ToolResult<null> => ({
      content: [{ type: "text", text: Array.isArray(id) ? `list ${id.join(",")}` : `one ${id}` }],
      details: null,
    }),
  });

  /* Turns an `id` holding a JSON array of strings into that array and leaves the rest alone. */
  function listFromText(args: unknown): unknown {
    if (typeof args !== "object" || args === null || !("id" in args)) return args;
    if (typeof args.id !== "string" || !args.id.startsWith("[")) return args;
    try {
      const parsed: unknown = JSON.parse(args.id);
      const strings = Array.isArray(parsed) && parsed.every((item) => typeof item === "string");
      return strings ? { ...args, id: parsed } : args;
    } catch {
      return args;
    }
  }

  it("hands Pi a prepareArguments that turns a list sent as text back into a list", async () => {
    const registered: PiToolDefinition[] = [];
    const pi = { registerTool: (definition: PiToolDefinition) => registered.push(definition) };
    registerPiTools(pi as unknown as PiExtensionAPI, [lookup, echo], {
      prepareArguments: { demo_lookup: listFromText },
    });
    const [tool, other] = registered;
    if (!tool?.prepareArguments) throw new Error("no prepareArguments on demo_lookup");
    const { prepareArguments } = tool;

    /* What Pi does with a call: prepare the raw arguments, then execute with the result. */
    const run = async (raw: unknown): Promise<unknown> =>
      (await tool.execute("call-1", prepareArguments(raw), undefined, undefined, {} as never))
        .content;

    expect(await run({ id: '["grok","claude","opencode"]' })).toEqual([
      { type: "text", text: "list grok,claude,opencode" },
    ]);
    expect(await run({ id: "grok" })).toEqual([{ type: "text", text: "one grok" }]);
    expect(await run({ id: '["grok",1]' })).toEqual([{ type: "text", text: 'one ["grok",1]' }]);
    const plain = { word: "hi" };
    expect(other?.prepareArguments?.(plain)).toBe(plain);
  });

  /* Lists, an enum list and a record, the shapes Pi 1.5 wraps or refuses when they come as text. */
  const tagger = defineTool({
    name: "demo_tag",
    title: "Demo Tag",
    description: "Tag some words.",
    effect: "read",
    input: Type.Object(
      {
        note: Type.Optional(Type.String()),
        words: Type.Optional(Type.Array(Type.String())),
        kinds: Type.Optional(Type.Array(Type.Enum(["assignment", "label"]))),
        fields: Type.Optional(Type.Record(Type.String(), Type.String())),
      },
      { additionalProperties: false },
    ),
    execute: (input): ToolResult<null> => ({
      content: [{ type: "text", text: JSON.stringify(input) }],
      details: null,
    }),
  });

  /* The repair Pi runs on demo_tag, with or without one of the caller's own. */
  function tagRepair(options: PiToolOptions = {}): (args: unknown) => unknown {
    const registered: PiToolDefinition[] = [];
    const pi = { registerTool: (definition: PiToolDefinition) => registered.push(definition) };
    registerPiTools(pi as unknown as PiExtensionAPI, [tagger], options);
    const prepare = registered[0]?.prepareArguments;
    if (!prepare) throw new Error("no prepareArguments on demo_tag");
    return (args) => Reflect.apply(prepare, undefined, [args]);
  }

  it("parses arrays and objects a model sent as JSON text", () => {
    const prepare = tagRepair();
    expect(
      prepare({
        words: '["abandon","zoo"]',
        kinds: ' ["assignment"]',
        fields: '{"Priority":"Medium"}',
      }),
    ).toEqual({
      words: ["abandon", "zoo"],
      kinds: ["assignment"],
      fields: { Priority: "Medium" },
    });
  });

  it("leaves text alone unless its parse fits the schema", () => {
    const prepare = tagRepair();
    const cases = [
      { note: '["abandon"]' },
      { words: '["abandon",7]' },
      { kinds: '["assignee"]' },
      { fields: '{"Priority":1}' },
      { words: "[abandon" },
      { words: "abandon" },
      { fields: '["Medium"]' },
    ];
    for (const args of cases) expect(prepare(args)).toBe(args);
    for (const args of [null, "words", ['["abandon"]']]) expect(prepare(args)).toBe(args);
  });

  it("hands the caller's repair the parsed arguments", () => {
    const seen: unknown[] = [];
    const prepare = tagRepair({
      prepareArguments: {
        demo_tag: (args) => (seen.push(args), { ...(args as object), note: "x" }),
      },
    });
    expect(prepare({ words: '["zoo"]' })).toEqual({ words: ["zoo"], note: "x" });
    expect(seen).toEqual([{ words: ["zoo"] }]);
  });

  it("still validates what prepareArguments hands back", async () => {
    const registered: PiToolDefinition[] = [];
    const pi = { registerTool: (definition: PiToolDefinition) => registered.push(definition) };
    registerPiTools(pi as unknown as PiExtensionAPI, [lookup], {
      prepareArguments: { demo_lookup: () => ({ id: 7 }) },
    });
    const [tool] = registered;
    if (!tool?.prepareArguments) throw new Error("no prepareArguments on demo_lookup");
    const prepared = tool.prepareArguments({ id: "grok" });
    await expect(
      tool.execute("call-1", prepared, undefined, undefined, {} as never),
    ).rejects.toThrow("Invalid arguments at /id");
  });

  it("refuses a prepareArguments for a tool that isn't in the list", () => {
    expect(() => register({ prepareArguments: { demo_ecko: (args) => args } })).toThrow(
      new ToolDefinitionError('prepareArguments names "demo_ecko", which isn\'t in the tool list'),
    );
  });

  describe("exposure", () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    /* What each tool's registration carries, by name. */
    function reach(options: PiToolOptions = {}): Record<string, unknown> {
      const registered: PiToolDefinition[] = [];
      const pi = { registerTool: (definition: PiToolDefinition) => registered.push(definition) };
      registerPiTools(pi as unknown as PiExtensionAPI, [echo, count], options);
      return Object.fromEntries(registered.map((tool) => [tool.name, tool.exposure]));
    }

    it("leaves Pi's default when nobody picks one", () => {
      const definition = register({});
      expect(definition).not.toHaveProperty("exposure");
      expect(definition).not.toHaveProperty("namespace");
    });

    it("takes one exposure for every tool, or one per name with a default", () => {
      expect(reach({ exposure: "deferred" })).toEqual({
        demo_echo: "deferred",
        demo_count: "deferred",
      });
      expect(reach({ exposure: { default: "codemode", tools: { demo_echo: "direct" } } })).toEqual({
        demo_echo: "direct",
        demo_count: "codemode",
      });
      expect(reach({ exposure: { tools: { demo_echo: "deferred" } } })).toEqual({
        demo_echo: "deferred",
        demo_count: undefined,
      });
    });

    it("lets the environment beat the package, and a package variable beat the global one", () => {
      vi.stubEnv("AGNTN_PI_EXPOSURE", "deferred");
      expect(reach({ exposure: "direct" })).toEqual({
        demo_echo: "deferred",
        demo_count: "deferred",
      });
      vi.stubEnv("AGNTN_PI_EXPOSURE_DEMO", "direct");
      expect(reach()).toEqual({ demo_echo: "direct", demo_count: "direct" });
      vi.stubEnv("AGNTN_PI_EXPOSURE_DEMO", "");
      expect(reach()).toEqual({ demo_echo: "deferred", demo_count: "deferred" });
    });

    it("refuses an exposure Pi doesn't know, wherever it came from", () => {
      const takes = "takes direct, model-only, codemode, deferred, hidden";
      expect(() => reach({ exposure: { tools: { demo_echo: "lazy" as never } } })).toThrow(
        new ToolDefinitionError(`exposure of demo_echo is "lazy"; ${takes}`),
      );
      vi.stubEnv("AGNTN_PI_EXPOSURE_DEMO", "Deferred");
      expect(() => reach()).toThrow(
        new ToolDefinitionError(`AGNTN_PI_EXPOSURE_DEMO is "Deferred"; ${takes}`),
      );
    });

    it("checks the whole option even when no tool would read a value", () => {
      const takes = "takes direct, model-only, codemode, deferred, hidden";
      const pi = { registerTool: () => 0 } as unknown as PiExtensionAPI;
      expect(() => registerPiTools(pi, [], { exposure: "lazy" as never })).toThrow(
        new ToolDefinitionError(`exposure is "lazy"; ${takes}`),
      );
      const shadowed: PiToolOptions["exposure"] = {
        default: {} as never,
        tools: { demo_echo: "direct", demo_count: "direct" },
      };
      expect(() => reach({ exposure: shadowed })).toThrow(
        new ToolDefinitionError(`exposure.default isn't a string; ${takes}`),
      );
      vi.stubEnv("AGNTN_PI_EXPOSURE", "lazy");
      expect(() => registerPiTools(pi, [])).toThrow(
        new ToolDefinitionError(`AGNTN_PI_EXPOSURE is "lazy"; ${takes}`),
      );
    });

    it("registers nothing when one package variable is wrong", () => {
      const other = defineTool({ ...echo, name: "other_echo" });
      const registered: PiToolDefinition[] = [];
      const pi = { registerTool: (definition: PiToolDefinition) => registered.push(definition) };
      vi.stubEnv("AGNTN_PI_EXPOSURE_OTHER", "lazy");
      expect(() => registerPiTools(pi as unknown as PiExtensionAPI, [echo, other])).toThrow(
        new ToolDefinitionError(
          'AGNTN_PI_EXPOSURE_OTHER is "lazy"; takes direct, model-only, codemode, deferred, hidden',
        ),
      );
      expect(registered).toEqual([]);
    });

    it("refuses an exposure for a tool that isn't in the list", () => {
      expect(() => reach({ exposure: { tools: { demo_ecko: "direct" } } })).toThrow(
        new ToolDefinitionError('exposure.tools names "demo_ecko", which isn\'t in the tool list'),
      );
    });

    it("hands every tool its own copy of the namespace", () => {
      const namespace = { name: "demo", description: "Demo tools" };
      const registered: PiToolDefinition[] = [];
      const pi = { registerTool: (definition: PiToolDefinition) => registered.push(definition) };
      registerPiTools(pi as unknown as PiExtensionAPI, [echo, count], { namespace });
      const [first, second] = registered;
      expect(first?.namespace).toEqual(namespace);
      expect(first?.namespace).not.toBe(second?.namespace);
    });
  });
});

let passes = 0;
let lateAsk: ToolCallContext["ask"];
/* Asks for a color, then for the details, and counts how often it starts over. */
const asker = defineTool({
  name: "demo_ask",
  title: "Demo Ask",
  description: "Ask the user for a color and some details.",
  effect: "read",
  input: Type.Object({}),
  async execute(_input, { ask }): Promise<ToolResult<null>> {
    passes++;
    lateAsk = ask;
    const say = (text: string): ToolResult<null> => ({
      content: [{ type: "text", text }],
      details: null,
    });
    if (!ask) return say("nobody to ask");
    const picked = await ask({
      message: "Pick a color\n\u001B[31mnow‮",
      schema: Type.Object({ color: Type.Enum(["red", "green"]) }),
    });
    if (picked.action !== "accept") return say(`color ${picked.action}`);
    const details = await ask({ message: "Details", schema: detailsForm });
    if (details.action !== "accept") return say(`details ${details.action}`);
    const { count, tags, loud, note } = details.content;
    return say(
      `${picked.content.color} x${count} tags=${tags?.join(",") ?? "-"} loud=${loud} note=${note ?? "-"}`,
    );
  },
});

const detailsForm = Type.Object({
  count: Type.Integer({ minimum: 1, title: "Count" }),
  tags: Type.Optional(Type.Array(Type.Enum(["a", "b"]))),
  loud: Type.Boolean(),
  note: Type.Optional(Type.String({ description: "Anything else" })),
});

const colorWire = {
  mode: "form",
  message: "Pick a color\nnow",
  requestedSchema: {
    type: "object",
    properties: { color: { type: "string", enum: ["red", "green"] } },
    required: ["color"],
  },
};

const replies = [
  { action: "accept", content: { color: "red" } },
  { action: "accept", content: { count: 3, tags: ["b"], loud: true } },
];

/**
 * A client that fills forms from `script` and keeps each form it was shown in `seen`.
 *
 * @param script - Replies in order.
 * @param pin - Protocol revision to insist on, else the SDK's 2025 default.
 * @returns {{ client: Client; seen: unknown[] }} Unconnected client and its record.
 */
function formClient(script: readonly unknown[], pin?: string): { client: Client; seen: unknown[] } {
  const client = new Client(
    { name: "test", version: "0.0.0" },
    {
      capabilities: { elicitation: { form: {} } },
      ...(pin === undefined ? {} : { versionNegotiation: { mode: { pin } } }),
    },
  );
  const seen: unknown[] = [];
  const left = [...script];
  client.setRequestHandler("elicitation/create", (request) => {
    const { _meta: _progress, ...params } = request.params as Record<string, unknown>;
    seen.push(params);
    return left.shift() as never;
  });
  open.push(client);
  return { client, seen };
}

/**
 * `formClient` on the stdio `Server`, which answers 2025 requests through the SDK's shim.
 *
 * @param script - Replies in order.
 * @returns {Promise<{ client: Client; seen: unknown[] }>} Connected client and its record.
 */
async function askingMcpClient(
  script: readonly unknown[],
): Promise<{ client: Client; seen: unknown[] }> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer({ name: "demo", version: "0.0.0" }, [asker]);
  const asking = formClient(script);
  open.push(server);
  await Promise.all([server.connect(serverTransport), asking.client.connect(clientTransport)]);
  return asking;
}

/**
 * `formClient` on h3-mcp over Streamable HTTP.
 *
 * @param script - Replies in order.
 * @param pin - Protocol revision to insist on.
 * @returns {Promise<{ client: Client; seen: unknown[] }>} Connected client and its record.
 */
async function askingH3Client(
  script: readonly unknown[],
  pin?: string,
): Promise<{ client: Client; seen: unknown[] }> {
  const app = new H3().all(
    "/mcp",
    defineMcpHandler({
      name: "demo",
      version: "0.0.0",
      tools: toH3Tools({ name: "demo" }, [asker]),
    }),
  );
  const transport = new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
    fetch: async (input, init) => app.fetch(new Request(input, init)),
  });
  const asking = formClient(script, pin);
  await asking.client.connect(transport);
  return asking;
}

/**
 * An SDK v1 client on a toolkit server serving `demo_ask`, its forms filled from `script`.
 *
 * @param script - Replies in order; once they run out, a question waits until it is cancelled.
 * @param setup - Whether the server passes `useMcpElicitation`, and what the client declares.
 * @returns {Promise<AskingToolkit>} The client, its server and what the client saw.
 */
async function askingToolkitClient(
  script: readonly unknown[],
  setup: Readonly<{ elicitation?: boolean; capabilities?: Readonly<Record<string, unknown>> }> = {},
): Promise<AskingToolkit> {
  const { elicitation = true, capabilities = { elicitation: { form: {} } } } = setup;
  const client = new SdkV1Client({ name: "test", version: "0.0.0" }, { capabilities });
  const server = toolkitServer([asker], elicitation);
  const seen: unknown[] = [];
  const cancelled: string[] = [];
  const left = [...script];
  if (capabilities.elicitation !== undefined) {
    client.setRequestHandler(ElicitRequestSchema, async (request, extra) => {
      seen.push(request.params);
      const reply = left.shift();
      if (reply !== undefined) return reply as never;
      return await new Promise<never>((_resolve, reject) => {
        extra.signal.addEventListener("abort", () => {
          cancelled.push(request.params.message);
          reject(new Error("cancelled"));
        });
      });
    });
  }
  await toolkitClient(server, client);
  return { client, server, seen, cancelled };
}

/* What `askingToolkitClient` hands back. */
interface AskingToolkit {
  readonly client: SdkV1Client;
  readonly server: McpServer;
  readonly seen: unknown[];
  readonly cancelled: string[];
}

/* One pass of `demo_ask` over MCP with what a client would send back. */
async function roundTrip(
  responses: Readonly<Record<string, unknown>> | undefined,
  state: string | undefined,
) {
  return await callAsking(
    { name: "demo" },
    [asker],
    "demo_ask",
    {},
    {},
    questionRound(responses, state),
  );
}

/* The `requestState` of an `input_required` answer. */
function stateOf(result: unknown): string {
  return String((result as { requestState?: unknown }).requestState);
}

/* The `inputRequests` of an `input_required` answer. */
function inputRequestsOf(result: unknown): Record<string, unknown> {
  return (result as { inputRequests?: Record<string, unknown> }).inputRequests ?? {};
}

/* The text of a tool call's first block. */
function firstText(result: unknown): string {
  const [block] = (result as { content: Array<{ text?: string }> }).content;
  return block?.text ?? "";
}

describe("questions", () => {
  it("cleans the message, sends the form MCP takes and keeps only the fields it asked for", async () => {
    const shown: HostQuestion[] = [];
    const ask = hostAsk(async (question) => {
      shown.push(question);
      return { action: "accept", content: { color: "green", evil: "\u001B]0;x\u0007" } };
    });
    const answer = await ask({
      message: "Pick a color\n\u001B[31mnow‮",
      schema: Type.Object({ color: Type.Enum(["red", "green"]) }),
    });

    expect(answer).toEqual({ action: "accept", content: { color: "green" } });
    expect(shown.map(({ message, requested }) => ({ message, requested }))).toEqual([
      { message: colorWire.message, requested: colorWire.requestedSchema },
    ]);
  });

  it("puts each field label on one clean line and leaves the values alone", () => {
    const hostile = "Pick\n\u001B]0;x\u0007one\u202E";
    const field = Type.Enum(["a\nb"], { title: hostile, description: hostile });
    expect(
      requestedSchema({ message: "", schema: Type.Object({ pick: field }) }).properties,
    ).toEqual({
      pick: { type: "string", enum: ["a\nb"], title: "Pick one", description: "Pick one" },
    });
  });

  it("cleans the labels of a multiple pick's items and of titled choices too", () => {
    const hostile = "Pick\n\u001B]0;x\u0007one\u202E";
    const tags = Type.Array(Type.Enum(["a"], { title: hostile }));
    const titled = Type.Unsafe<string>({
      type: "string",
      oneOf: [{ const: "a", title: hostile }],
    });
    const { properties } = requestedSchema({
      message: "",
      schema: Type.Object({ tags, titled }),
    });

    expect(properties.tags).toEqual({
      type: "array",
      items: { type: "string", enum: ["a"], title: "Pick one" },
    });
    expect(properties.titled).toEqual({
      type: "string",
      oneOf: [{ const: "a", title: "Pick one" }],
    });
  });

  it("types an answer from its form, whatever the caller expects", async () => {
    const ask = hostAsk(async () => ({ action: "accept", content: { count: 2 } }));
    const schema = Type.Object({ count: Type.Number() });
    /* @ts-expect-error */
    const answer: ToolAnswer<{ name: string }> = await ask({ message: "How many?", schema });
    expect(answer).toEqual({ action: "accept", content: { count: 2 } });
  });

  it("refuses a rule on the form's root, which no MCP form can carry", () => {
    const schema = Type.Object({ a: Type.Optional(Type.String()) }, { minProperties: 1 });
    expect(() => requestedSchema({ message: "", schema })).toThrow(
      new ToolDefinitionError(
        'A question can\'t carry "minProperties" on its Type.Object: an MCP form has no place for it',
      ),
    );
  });

  it("types the items of a multiple pick and passes every other field through", () => {
    const suggested = Type.Object({ color: Type.String({ "x-openai-suggestions": ["red"] }) });
    expect(requestedSchema({ message: "", schema: suggested }).properties).toEqual({
      color: { type: "string", "x-openai-suggestions": ["red"] },
    });
    expect(requestedSchema({ message: "", schema: detailsForm })).toEqual({
      type: "object",
      properties: {
        count: { type: "integer", minimum: 1, title: "Count" },
        tags: { type: "array", items: { type: "string", enum: ["a", "b"] } },
        loud: { type: "boolean" },
        note: { type: "string", description: "Anything else" },
      },
      required: ["count", "loud"],
    });
  });

  it("refuses a form elicitation can't show before anyone sees it", async () => {
    let asked = false;
    const ask = hostAsk(async () => {
      asked = true;
      return { action: "cancel" };
    });
    const nested = Type.Object({ point: Type.Object({ x: Type.Number() }) });

    await expect(ask({ message: "Where?", schema: nested })).rejects.toThrow(
      new ToolDefinitionError(
        'Question field "point" must be a string, number, integer, boolean, Type.Enum of strings or an array of one',
      ),
    );
    expect(asked).toBe(false);
  });

  it("refuses a reply that doesn't fit, and takes a no or a closed form as they are", async () => {
    const ask = (reply: unknown) =>
      hostAsk(async () => reply)({ message: "How many?", schema: detailsForm });

    await expect(ask({ action: "accept", content: { count: 0, loud: true } })).rejects.toThrow(
      "The answer doesn't fit the question",
    );
    await expect(ask({ action: "maybe" })).rejects.toThrow("The answer doesn't fit the question");
    expect(await ask({ action: "decline", content: { count: 0 } })).toEqual({ action: "decline" });
    expect(await ask({ action: "cancel" })).toEqual({ action: "cancel" });
  });

  it("rejects a question once the call has answered", async () => {
    const result = await invokeTool(asker, {}, { ask: async () => ({ action: "cancel" }) });

    expect(resultText(result)).toBe("color cancel");
    await expect(lateAsk?.({ message: "Still there?", schema: Type.Object({}) })).rejects.toThrow(
      "demo_ask asked a question after its call had answered",
    );
  });

  it("is absent where nobody can answer", async () => {
    expect(resultText(await invokeTool(asker, {}))).toBe("nobody to ask");
  });

  it("replays every answer so far and stops at the first question still out", async () => {
    const first = await roundTrip(undefined, undefined);
    const second = await roundTrip({ "ask-0": replies[0] }, stateOf(first));
    const last = await roundTrip({ "ask-1": replies[1] }, stateOf(second));

    expect(Object.keys(inputRequestsOf(first))).toEqual(["ask-0"]);
    expect(Object.keys(inputRequestsOf(second))).toEqual(["ask-1"]);
    expect(firstText(last)).toBe("red x3 tags=b loud=true note=-");
  });

  it("asks again past a replayed answer that doesn't fit, as from a tampered state", async () => {
    const first = await roundTrip(undefined, undefined);
    const second = await roundTrip({ "ask-0": replies[0] }, stateOf(first));
    const state = JSON.parse(stateOf(second)) as { answers: Array<{ a: unknown }> };
    const [entry] = state.answers;
    if (entry) entry.a = { action: "accept", content: { color: "blue" } };
    const tampered = await roundTrip({ "ask-1": replies[1] }, JSON.stringify(state));

    expect(inputRequestsOf(tampered)).toEqual({
      "ask-0": { method: "elicitation/create", params: colorWire },
    });
  });

  it("asks again when the question changed since the answer came", async () => {
    let target = "A";
    const apply = defineTool({
      name: "demo_apply",
      title: "Demo Apply",
      description: "Ask before applying to the current target.",
      effect: "write",
      input: Type.Object({}),
      async execute(_input, { ask }): Promise<ToolResult<null>> {
        const answer = await ask?.({ message: `Apply to ${target}?`, schema: Type.Object({}) });
        return { content: [{ type: "text", text: `applied ${answer?.action}` }], details: null };
      },
    });
    const call = async (responses?: Readonly<Record<string, unknown>>, state?: string) =>
      await callAsking(
        { name: "demo" },
        [apply],
        "demo_apply",
        {},
        {},
        questionRound(responses, state),
      );

    const asked = await call();
    target = "B";
    const again = await call({ "ask-0": { action: "accept", content: {} } }, stateOf(asked));

    expect(JSON.stringify(inputRequestsOf(again))).toContain("Apply to B?");
  });

  it("asks a stdio client with elicitation, the call starting over for each answer", async () => {
    const { client, seen } = await askingMcpClient(replies);
    passes = 0;
    const result = await client.callTool({ name: "demo_ask", arguments: {} });

    expect(firstText(result)).toBe("red x3 tags=b loud=true note=-");
    expect(passes).toBe(3);
    expect(seen).toEqual([
      colorWire,
      {
        mode: "form",
        message: "Details",
        requestedSchema: requestedSchema({ message: "", schema: detailsForm }),
      },
    ]);
  });

  it("takes a decline from a stdio client as the answer", async () => {
    const { client } = await askingMcpClient([{ action: "decline" }]);
    expect(firstText(await client.callTool({ name: "demo_ask", arguments: {} }))).toBe(
      "color decline",
    );
  });

  it("asks a stdio client again when its reply doesn't fit the form", async () => {
    const { client, seen } = await askingMcpClient([
      { action: "accept", content: { color: "blue" } },
      ...replies,
    ]);
    const result = await client.callTool({ name: "demo_ask", arguments: {} });

    expect(firstText(result)).toBe("red x3 tags=b loud=true note=-");
    expect(seen.slice(0, 2)).toEqual([colorWire, colorWire]);
  });

  it("gives no ask to a client without elicitation", async () => {
    const client = await mcpClient([asker]);
    expect(firstText(await client.callTool({ name: "demo_ask", arguments: {} }))).toBe(
      "nobody to ask",
    );
  });

  it("asks over h3-mcp on the 2026 revision, the call starting over for each answer", async () => {
    const { client, seen } = await askingH3Client(replies, "2026-07-28");
    passes = 0;
    const result = await client.callTool({ name: "demo_ask", arguments: {} });

    expect(firstText(result)).toBe("red x3 tags=b loud=true note=-");
    expect(passes).toBe(3);
    expect(seen[0]).toEqual(colorWire);
  });

  it("gives no ask over h3-mcp on a 2025 request, which has no way to carry one", async () => {
    const { client } = await askingH3Client(replies);
    expect(firstText(await client.callTool({ name: "demo_ask", arguments: {} }))).toBe(
      "nobody to ask",
    );
  });

  it("asks a toolkit client on the call's own stream, the call running once", async () => {
    const { client, seen } = await askingToolkitClient(replies);
    passes = 0;
    const result = await client.callTool({ name: "demo_ask", arguments: {} });

    expect(firstText(result)).toBe("red x3 tags=b loud=true note=-");
    expect(passes).toBe(1);
    expect(seen).toEqual([
      colorWire,
      {
        mode: "form",
        message: "Details",
        requestedSchema: requestedSchema({ message: "", schema: detailsForm }),
      },
    ]);
  });

  it("takes a decline from a toolkit client as the answer", async () => {
    const { client } = await askingToolkitClient([{ action: "decline" }]);
    expect(firstText(await client.callTool({ name: "demo_ask", arguments: {} }))).toBe(
      "color decline",
    );
  });

  it("withdraws the session's first toolkit question when the client cancels the call", async () => {
    const client = new Client(
      { name: "test", version: "0.0.0" },
      { capabilities: { elicitation: { form: {} } } },
    );
    const asked: unknown[] = [];
    const cancelled: string[] = [];
    client.setRequestHandler(
      "elicitation/create",
      async (request, ctx) =>
        await new Promise<never>((_resolve, reject) => {
          asked.push(ctx.mcpReq.id);
          ctx.mcpReq.signal.addEventListener("abort", () => {
            cancelled.push(String(request.params.message));
            reject(new Error("cancelled"));
          });
        }),
    );
    const server = toolkitServer([asker], true);
    const [clientTransport, serverTransport] = SdkV1Transport.createLinkedPair();
    open.push(client, server);
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const stop = new AbortController();
    const call = client.callTool({ name: "demo_ask", arguments: {} }, { signal: stop.signal });
    await expect.poll(() => asked).toEqual([0]);
    stop.abort(new Error("changed my mind"));

    await expect(call).rejects.toThrow("changed my mind");
    await expect.poll(() => cancelled).toEqual([colorWire.message]);
  });

  it("gives no ask over the toolkit to a client without elicitation", async () => {
    const { client, seen } = await askingToolkitClient(replies, { capabilities: {} });
    expect(firstText(await client.callTool({ name: "demo_ask", arguments: {} }))).toBe(
      "nobody to ask",
    );
    expect(seen).toEqual([]);
  });

  it("gives no ask over the toolkit without useMcpElicitation", async () => {
    const { client } = await askingToolkitClient(replies, { elicitation: false });
    expect(firstText(await client.callTool({ name: "demo_ask", arguments: {} }))).toBe(
      "nobody to ask",
    );
  });
});

/**
 * A `ctx` whose dialogs answer from `script` and record what they drew.
 *
 * @param script - Answers in order; `undefined` is Escape.
 * @param hasUI - Whether the host has a UI right now.
 * @returns {{ drawn: string[]; ctx: object }} The record and the context.
 */
function scriptedCtx(script: ReadonlyArray<string | undefined>, hasUI = true) {
  const drawn: string[] = [];
  const left = [...script];
  const ui = {
    select: async (
      title: string,
      options: readonly string[],
      dialog?: Readonly<{ signal?: AbortSignal }>,
    ) => {
      drawn.push(`select ${title} [${options.join(" | ")}]${dialog?.signal ? " signal" : ""}`);
      return left.shift();
    },
    input: async (title: string, placeholder?: string) => {
      drawn.push(`input ${title} (${placeholder ?? ""})`);
      return left.shift();
    },
    notify: (message: string, type?: string) => {
      drawn.push(`notify ${type ?? "info"} ${message}`);
    },
  };
  return { drawn, ctx: { hasUI, ui } };
}

/* Registers `demo_ask` on a Pi double and hands back its definition. */
function piAsker(): PiToolDefinition {
  const registered: PiToolDefinition[] = [];
  const pi = { registerTool: (definition: PiToolDefinition) => registered.push(definition) };
  registerPiTools(pi as unknown as PiExtensionAPI, [asker]);
  const [tool] = registered;
  if (!tool) throw new Error("nothing registered");
  return tool;
}

describe("questions in Pi and OMP", () => {
  const filled = ["red", "0", "3", "[ ] a", "Done", "Yes", ""];

  it("asks for each field through ctx.ui and names a value the field refuses", async () => {
    const { drawn, ctx } = scriptedCtx(filled);
    const result = await piAsker().execute(
      "call-1",
      {},
      new AbortController().signal,
      undefined,
      ctx as never,
    );

    expect(resultText(result as ToolResult)).toBe("red x3 tags=a loud=true note=-");
    expect(drawn).toEqual([
      "select Pick a color now [red | green] signal",
      "input Details: Count ()",
      "notify warning Count: must be >= 1",
      "input Details: Count ()",
      "select Details: tags [[ ] a | [ ] b | Done | (skip)] signal",
      "select Details: tags [[x] a | [ ] b | Done | (skip)] signal",
      "select Details: loud [Yes | No] signal",
      "input Details: note (Anything else)",
    ]);
  });

  it("asks again for a line the list never had, instead of leaving a required field out", async () => {
    const { drawn, ctx } = scriptedCtx(["blue", "red", undefined]);
    await piAsker().execute("call-1", {}, undefined, undefined, ctx as never);

    expect(drawn.slice(0, 3)).toEqual([
      "select Pick a color now [red | green]",
      "notify warning color: must be one of red, green",
      "select Pick a color now [red | green]",
    ]);
  });

  it("tells apart two values that clean to the same line", async () => {
    const twins = defineTool({
      ...asker,
      name: "demo_twins",
      async execute(_input, { ask }): Promise<ToolResult<null>> {
        const answer = await ask?.({
          message: "Which?",
          schema: Type.Object({ pick: Type.Enum(["a\nb", "a b"]) }),
        });
        const text = answer?.action === "accept" ? JSON.stringify(answer.content.pick) : "none";
        return { content: [{ type: "text", text }], details: null };
      },
    });
    const registered: PiToolDefinition[] = [];
    const pi = { registerTool: (definition: PiToolDefinition) => registered.push(definition) };
    registerPiTools(pi as unknown as PiExtensionAPI, [twins]);
    const { drawn, ctx } = scriptedCtx(["a b (2)"]);
    const result = await registered[0]?.execute("call-1", {}, undefined, undefined, ctx as never);

    expect(drawn).toEqual(["select Which? [a b | a b (2)]"]);
    expect(resultText(result as ToolResult)).toBe('"a b"');
  });

  it("leaves an optional multiple pick out on (skip), not as an empty list", async () => {
    const { ctx } = scriptedCtx(["red", "3", "[ ] a", "(skip)", "No", "hi"]);
    const result = await piAsker().execute("call-1", {}, undefined, undefined, ctx as never);

    expect(resultText(result as ToolResult)).toBe("red x3 tags=- loud=false note=hi");
  });

  it("keeps a field named __proto__ as a field", async () => {
    const odd = defineTool({
      ...asker,
      name: "demo_odd",
      async execute(_input, { ask }): Promise<ToolResult<null>> {
        const answer = await ask?.({
          message: "Odd",
          schema: Type.Object({ ["__proto__"]: Type.String() }),
        });
        const text = answer?.action === "accept" ? JSON.stringify(answer.content) : "none";
        return { content: [{ type: "text", text }], details: null };
      },
    });
    const registered: PiToolDefinition[] = [];
    const pi = { registerTool: (definition: PiToolDefinition) => registered.push(definition) };
    registerPiTools(pi as unknown as PiExtensionAPI, [odd]);
    const { ctx } = scriptedCtx(["x"]);
    const result = await registered[0]?.execute("call-1", {}, undefined, undefined, ctx as never);

    expect(resultText(result as ToolResult)).toBe('{"__proto__":"x"}');
  });

  it("closes the whole form on Escape", async () => {
    const { drawn, ctx } = scriptedCtx(["red", undefined]);
    const result = await piAsker().execute("call-1", {}, undefined, undefined, ctx as never);

    expect(resultText(result as ToolResult)).toBe("details cancel");
    expect(drawn).toHaveLength(2);
  });

  it("asks nobody without a UI", async () => {
    const { drawn, ctx } = scriptedCtx(filled, false);
    const result = await piAsker().execute("call-1", {}, undefined, undefined, ctx as never);

    expect(resultText(result as ToolResult)).toBe("nobody to ask");
    expect(drawn).toEqual([]);
  });

  it("draws the same dialogs in OMP", async () => {
    const registered: OmpToolDefinition[] = [];
    const pi = {
      typebox: { Type: { Unsafe: (document: unknown) => document } },
      registerTool: (definition: OmpToolDefinition) => registered.push(definition),
    };
    registerOmpTools(pi as unknown as ExtensionAPI, [asker], {
      Text: class {} as unknown as OmpToolOptions["Text"],
    });
    const { drawn, ctx } = scriptedCtx(filled);
    const result = await registered[0]?.execute("call-1", {}, undefined, undefined, ctx as never);

    expect(resultText(result as ToolResult)).toBe("red x3 tags=a loud=true note=-");
    expect(drawn).toHaveLength(8);
  });
});

let writes = 0;
/* Swallows every error around its question, then writes: the shape that must not run early. */
const careless = defineTool({
  name: "demo_careless",
  title: "Demo Careless",
  description: "Ask, shrug off any failure, then write.",
  effect: "write",
  input: Type.Object({}),
  async execute(_input, { ask, signal }): Promise<ToolResult<null>> {
    let color = "none";
    try {
      const answer = await ask?.({
        message: "Pick",
        schema: Type.Object({ color: Type.String() }),
      });
      if (answer?.action === "accept") color = answer.content.color;
    } catch {}
    writes++;
    return {
      content: [{ type: "text", text: `${color} ${String(signal?.aborted)}` }],
      details: null,
    };
  },
});

describe("a question nobody has answered yet", () => {
  it("holds the call where it asked, so a caught error can't run the write early", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer({ name: "demo", version: "0.0.0" }, [careless]);
    const { client } = formClient([{ action: "accept", content: { color: "red" } }]);
    open.push(server);
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    writes = 0;

    expect(firstText(await client.callTool({ name: "demo_careless", arguments: {} }))).toBe(
      "red false",
    );
    expect(writes).toBe(1);
  });
});

/* Starts a question and returns without waiting for it, the bug a missing `await` makes. */
const hasty = defineTool({
  name: "demo_hasty",
  title: "Demo Hasty",
  description: "Ask and forget to wait.",
  effect: "read",
  input: Type.Object({}),
  execute(_input, { ask }): ToolResult<null> {
    void ask?.({ message: "Pick", schema: Type.Object({ color: Type.String() }) });
    return { content: [{ type: "text", text: "done" }], details: null };
  },
});

describe("a question the tool forgot to wait for", () => {
  it("still reaches the client before the call answers", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer({ name: "demo", version: "0.0.0" }, [hasty]);
    const { client, seen } = formClient([{ action: "accept", content: { color: "red" } }]);
    open.push(server);
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    expect(firstText(await client.callTool({ name: "demo_hasty", arguments: {} }))).toBe("done");
    expect(seen).toHaveLength(1);
  });

  it("still reaches the client when the tool throws next to it", async () => {
    const reckless = defineTool({
      ...hasty,
      name: "demo_reckless",
      execute(_input, { ask }): ToolResult<null> {
        void ask?.({ message: "Pick", schema: Type.Object({ color: Type.String() }) });
        throw new Error("boom");
      },
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer({ name: "demo", version: "0.0.0" }, [reckless]);
    const { client, seen } = formClient([{ action: "accept", content: { color: "red" } }]);
    open.push(server);
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    expect(firstText(await client.callTool({ name: "demo_reckless", arguments: {} }))).toBe(
      "demo_reckless failed: boom",
    );
    expect(seen).toHaveLength(1);
  });

  it("swallows nothing it hands out: a refused question left unawaited stays handled", async () => {
    const sloppy = defineTool({
      ...hasty,
      name: "demo_sloppy",
      execute(_input, { ask }): ToolResult<null> {
        const nested = Type.Object({ point: Type.Object({ x: Type.Number() }) });
        void ask?.({ message: "Where?", schema: nested });
        return { content: [{ type: "text", text: "done" }], details: null };
      },
    });
    const ask = hostAsk(async () => ({ action: "cancel" }));

    expect(resultText(await invokeTool(sloppy, {}, { ask }))).toBe("done");
  });

  it("keeps the Pi call open until its dialog closes", async () => {
    const registered: PiToolDefinition[] = [];
    const pi = { registerTool: (definition: PiToolDefinition) => registered.push(definition) };
    registerPiTools(pi as unknown as PiExtensionAPI, [hasty]);
    const { drawn, ctx } = scriptedCtx(["red"]);
    const result = await registered[0]?.execute("call-1", {}, undefined, undefined, ctx as never);

    expect(resultText(result as ToolResult)).toBe("done");
    expect(drawn).toEqual(["input Pick ()"]);
  });
});
