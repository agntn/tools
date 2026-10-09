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
import { asSchema } from "ai";
import { H3 } from "h3";
import { defineMcpHandler } from "h3-mcp";
import { Client as SdkV1Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport as SdkV1Transport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AnySchema } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import type { CallToolResult as SdkV1Result } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vite-plus/test";
import type { z } from "zod";

import { toAiTool, toAiTools } from "../src/ai.ts";
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
  resultText,
  type Icon,
  type ToolCallContext,
  type ToolDefinition,
  type ToolResult,
} from "../src/index.ts";
import { toH3Tools } from "../src/h3.ts";
import { callTool, createMcpServer, listTools } from "../src/mcp.ts";
import { callAsking, questionRound } from "../src/mcp-answers.ts";
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
    const probe = defineTool({
      name: "demo_signal",
      title: "Demo Signal",
      description: "Report whether the call was aborted.",
      effect: "read",
      input: Type.Object({}),
      execute: (_input, context) => ({
        content: [{ type: "text", text: String(context.signal?.aborted) }],
        details: null,
      }),
    });

    expect(
      await callTool({ name: "demo" }, [probe], "demo_signal", {}, { signal: AbortSignal.abort() }),
    ).toEqual({ content: [{ type: "text", text: "true" }] });
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
 * An SDK v1 client on an `McpServer` that registers each entry the way the toolkit does.
 *
 * The toolkit's own module needs Nitro, so this repeats its `registerToolFromDefinition` call.
 * Bare SDK v1 types the result tighter than the toolkit does, hence the cast.
 *
 * @returns {Promise<SdkV1Client>} Connected client.
 */
async function toolkitClient(): Promise<SdkV1Client> {
  const server = new McpServer({ name: "demo", version: "0.0.0" });
  for (const tool of toToolkitTools({ name: "demo" }, [echo, slow, signal, count])) {
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
  const [clientTransport, serverTransport] = SdkV1Transport.createLinkedPair();
  const client = new SdkV1Client({ name: "test", version: "0.0.0" });
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

  it("gives the tool no progress callback, since the AI SDK has nowhere to show it", async () => {
    const tool = toAiTool(slow);
    if (!tool.execute) throw new Error("tool not executable");
    expect(await tool.execute({}, { toolCallId: "1", messages: [], context: {} })).toEqual({
      details: null,
      text: "progress off",
    });
  });

  it("refuses details with a text field instead of overwriting it", async () => {
    const clash = defineTool({
      name: "demo_clash",
      title: "Clash",
      description: "x",
      effect: "read",
      input: Type.Object({}),
      execute: () => ({ content: [{ type: "text", text: "shown" }], details: { text: "slice" } }),
    });
    const tool = toAiTool(clash);
    if (!tool.execute) throw new Error("tool not executable");

    await expect(tool.execute({}, { toolCallId: "1", messages: [], context: {} })).rejects.toThrow(
      "details must not have a text field",
    );
  });
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
      text: "[status.done] <accent>Demo Slow</accent> <accent>[read]</accent>",
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

  it("asks again past a replayed answer that doesn't fit, as from a tampered state", async () => {
    const round = questionRound(
      { "ask-1": replies[1] },
      JSON.stringify([{ action: "accept", content: { color: "blue" } }]),
    );
    const result = await callAsking({ name: "demo" }, [asker], "demo_ask", {}, {}, round);

    expect(result).toBe(round.pending());
    expect(result).toEqual({
      resultType: "input_required",
      inputRequests: { "ask-0": { method: "elicitation/create", params: colorWire } },
      requestState: "[]",
    });
  });

  it("hands nothing to send once every question has its answer", async () => {
    const round = questionRound({ "ask-1": replies[1] }, JSON.stringify([replies[0]]));
    const result = await callTool({ name: "demo" }, [asker], "demo_ask", {}, { ask: round.ask });

    expect(firstText(result)).toBe("red x3 tags=b loud=true note=-");
    expect(round.pending()).toBeUndefined();
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
