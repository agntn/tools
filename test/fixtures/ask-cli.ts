/* One tool that asks a question, so a test can watch a raw stdio client get the form. */
import { runCli } from "../../src/cli.ts";
import { defineTool, Type } from "../../src/index.ts";

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

await runCli({
  name: "demo",
  version: "1.2.3",
  description: "Asks for a colour",
  tools: [colour],
  mcp: true,
});
