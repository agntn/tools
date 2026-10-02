/**
 * Demo tools for the CLI tests, run in process and as `node test/fixtures/demo-cli.ts`.
 */

import { defineTool, Type, type ToolResult } from "../../src/index.ts";

export class DemoError extends Error {}

export const echo = defineTool({
  name: "demo_echo",
  title: "Demo Echo",
  description: "Echo a word. The second sentence stays out of the command list.",
  effect: "read",
  input: Type.Object(
    {
      word: Type.String({ pattern: "^[a-z]+$", maxLength: 8, description: "Word to echo" }),
      mode: Type.Optional(Type.Enum(["plain", "loud"])),
      times: Type.Optional(Type.Integer({ minimum: 1, maximum: 3 })),
      spaced: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: false },
  ),
  cli: { positional: ["word"] },
  execute({ word, mode, times, spaced }): ToolResult<{ word: string; times: number }> {
    if (word === "fail") {
      return {
        content: [{ type: "text", text: "cannot echo fail" }],
        details: { word, times: 0 },
        isError: true,
      };
    }
    if (word === "boom") throw new Error("exploded");
    if (word === "known") throw new DemoError("known\nfailure");
    if (word === "escape") {
      return {
        content: [{ type: "text", text: "a\u001B[31mred\u001B[0m‮b\nnext" }],
        details: { word, times: 1 },
      };
    }
    const once = mode === "loud" ? word.toUpperCase() : word;
    return {
      content: [
        {
          type: "text",
          text: Array.from({ length: times ?? 1 }, () => once).join(spaced === true ? " " : ""),
        },
      ],
      details: { word, times: times ?? 1 },
    };
  },
});

export const measure = defineTool({
  name: "demo_text_measure",
  title: "Demo Measure",
  description: "Measure text.",
  effect: "read",
  input: Type.Object(
    {
      text: Type.String({ description: "Text to measure" }),
      weights: Type.Optional(Type.Record(Type.String(), Type.Integer())),
    },
    { additionalProperties: false },
  ),
  cli: { command: "measure", aliases: ["len"], positional: ["text"], stdin: ["text"] },
  execute({ text, weights }): ToolResult<{ length: number }> {
    const extra = Object.values(weights ?? {}).reduce((sum, weight) => sum + weight, 0);
    const length = text.length + extra;
    return { content: [{ type: "text", text: String(length) }], details: { length } };
  },
});

export const demoTools = [echo, measure];
