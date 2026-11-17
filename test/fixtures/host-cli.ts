/* One tool that says what it found in `host`, so a test can ask it over real stdio. */
import { runCli } from "../../src/cli.ts";
import { defineTool, Type } from "../../src/index.ts";
import type { McpHost } from "../../src/mcp.ts";

const peek = defineTool({
  name: "demo_host",
  title: "Demo Host",
  description: "Say what the host context holds.",
  effect: "read",
  input: Type.Object({}),
  execute(_input, { host }) {
    const { request, meta } = (host ?? {}) as Partial<McpHost>;
    const details = {
      host: host !== undefined,
      request: request !== undefined,
      meta: meta ?? null,
    };
    return { content: [{ type: "text", text: JSON.stringify(details) }], details };
  },
});

await runCli({
  name: "demo",
  version: "1.2.3",
  description: "Host peek",
  tools: [peek],
  mcp: true,
});
