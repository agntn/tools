/** The demo tools with `mcp` given the server's own introduction instead of `true`. */
import { runCli } from "../../src/cli.ts";
import { demoTools, serverInfo } from "./demo.ts";

await runCli({
  name: "demo",
  version: "1.2.3",
  description: "Demo tools",
  tools: demoTools,
  mcp: serverInfo,
});
