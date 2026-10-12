/**
 * A tool built from `src` handed to the adapters built into `dist`. Two copies of the package,
 * each with its own TypeBox, the way a docs site and its library meet: both must fit.
 */
import { toAiTool, toAiTools } from "../../dist/ai.mjs";
import { createCli } from "../../dist/cli.mjs";
import { toH3Tools } from "../../dist/h3.mjs";
import { invokeTool, type ToolDefinition } from "../../dist/index.mjs";
import { callTool, createMcpServer, listTools } from "../../dist/mcp.mjs";
import { registerOmpTools } from "../../dist/omp.mjs";
import { registerPiTools } from "../../dist/pi.mjs";
import { toToolkitTools } from "../../dist/toolkit.mjs";
import { Type, defineTool } from "../../src/index.ts";

const pick = defineTool({
  name: "copies_pick",
  title: "Pick",
  description: "Asks for a color and says it back.",
  effect: "read",
  input: Type.Object({ word: Type.String() }),
  async execute({ word }, { ask }) {
    const answer = await ask?.({
      message: "Which one?",
      schema: Type.Object({ color: Type.Enum(["red", "green"]) }),
    });
    const color = answer?.action === "accept" ? answer.content.color : "none";
    return { content: [{ type: "text", text: `${word} ${color}` }], details: { color } };
  },
});

const tools = [pick];
const info = { name: "copies", version: "0.0.0", description: "Two copies." };

declare const pi: Parameters<typeof registerPiTools>[0];
declare const omp: Parameters<typeof registerOmpTools>[0];
declare const ompOptions: Parameters<typeof registerOmpTools>[2];

export const list: readonly ToolDefinition[] = tools;

export const surfaces = [
  createMcpServer(info, tools),
  listTools(tools),
  callTool(info, tools, pick.name),
  invokeTool(pick, { word: "hi" }),
  toH3Tools(info, tools),
  toToolkitTools(info, tools),
  toAiTool(pick),
  toAiTools(tools),
  createCli({ ...info, tools }),
  registerPiTools(pi, tools),
  registerOmpTools(omp, tools, ompOptions),
];
