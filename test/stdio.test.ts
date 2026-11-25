import { PassThrough } from "node:stream";

import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { describe, expect, it } from "vite-plus/test";

import { defineTool, Type } from "../src/index.ts";
import { createMcpServer } from "../src/mcp.ts";
import { serveStdio } from "../src/stdio.ts";

const colour = defineTool({
  name: "demo_colour",
  title: "Demo Colour",
  description: "Ask for a colour.",
  effect: "read",
  input: Type.Object({}),
  async execute(_input, { ask }) {
    const answer =
      ask === undefined
        ? null
        : await ask({ message: "Colour?", schema: Type.Object({ colour: Type.String() }) });
    return { content: [{ type: "text", text: JSON.stringify(answer) }], details: answer };
  },
});

const meta = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": { name: "raw", version: "0" },
  "io.modelcontextprotocol/clientCapabilities": { elicitation: { form: {} } },
};

/* Serves the tool over two streams and waits for the answer to `id`. */
async function exchange(lines: readonly object[], id: number): Promise<unknown> {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const handle = serveStdio(() => createMcpServer({ name: "demo", version: "0" }, [colour]), {
    transport: new StdioServerTransport(stdin, stdout),
  });
  const answer = new Promise<unknown>((resolve) => {
    let buffer = "";
    stdout.setEncoding("utf8");
    stdout.on("data", (chunk: string) => {
      buffer += chunk;
      for (const line of buffer.split("\n").slice(0, -1)) {
        const message = JSON.parse(line) as { id?: unknown };
        if (message.id === id) resolve(message);
      }
      buffer = buffer.slice(buffer.lastIndexOf("\n") + 1);
    });
  });
  stdin.write(lines.map((line) => `${JSON.stringify(line)}\n`).join(""));
  try {
    return await answer;
  } finally {
    await handle.close();
  }
}

describe("serveStdio", () => {
  it("lends a bare notification the envelope of the discover before it", async () => {
    const answer = await exchange(
      [
        { jsonrpc: "2.0", id: 1, method: "server/discover", params: { _meta: meta } },
        { jsonrpc: "2.0", method: "notifications/roots/list_changed", params: {} },
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "demo_colour", arguments: {}, _meta: meta },
        },
      ],
      2,
    );
    expect(answer).toMatchObject({ result: { resultType: "input_required" } });
  });

  it("still serves a 2025 client that opens with initialize", async () => {
    const answer = await exchange(
      [
        {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-11-25",
            capabilities: {},
            clientInfo: { name: "raw", version: "0" },
          },
        },
        { jsonrpc: "2.0", method: "notifications/initialized" },
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "demo_colour", arguments: {} },
        },
      ],
      2,
    );
    expect(answer).toMatchObject({ result: { content: [{ type: "text", text: "null" }] } });
  });
});
