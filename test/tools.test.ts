import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { asSchema } from "ai";
import { afterEach, describe, expect, it } from "vitest";

import { toAiTool, toAiTools } from "../src/ai.ts";
import {
  defineTool,
  indexTools,
  sanitizeLine,
  ToolDefinitionError,
  Type,
  validateInput,
  type ToolResult,
} from "../src/index.ts";
import { createMcpServer } from "../src/mcp.ts";

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

  it("reports the pattern at the property path", () => {
    const checked = validateInput(echo, { word: "a.b" });
    expect(checked.ok ? [] : checked.lines).toEqual([
      'Invalid arguments at /word: must match pattern "^[a-z]+$"',
    ]);
  });
});

describe("sanitizeLine", () => {
  it("removes escapes and replaces every line-forging character", () => {
    const hostile = "a\u001B]0;evil\u0007b\u001B[31mc\nd e‮f\u0085g\u009B1mh";
    expect(sanitizeLine(hostile)).toBe("abc d e f gh");
    expect(sanitizeLine(42)).toBe("42");
  });
});

const open: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((connection) => connection.close()));
});

async function mcpClient(): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer({ name: "demo", version: "0.0.0" }, [echo]);
  const client = new Client({ name: "test", version: "0.0.0" });
  open.push(client, server);
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

describe("MCP adapter", () => {
  it("lists the schema verbatim with annotations from the effect", async () => {
    const client = await mcpClient();
    const [tool] = (await client.listTools()).tools;

    expect(tool?.inputSchema).toEqual(JSON.parse(JSON.stringify(echo.input)));
    expect(tool?.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
  });

  it("passes success, returned failure, validation failure and thrown failure", async () => {
    const client = await mcpClient();
    const call = (args: Record<string, unknown>) =>
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

  it("treats prototype names as unknown tools", async () => {
    const client = await mcpClient();
    expect(await client.callTool({ name: "toString", arguments: {} })).toEqual({
      isError: true,
      content: [{ type: "text", text: 'Unknown demo tool: "toString"' }],
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
});
