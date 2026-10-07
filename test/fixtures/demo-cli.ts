import { runCli } from "../../src/cli.ts";
import { demoTools, DemoError, gzipMagic } from "./demo.ts";

await runCli({
  name: "demo",
  version: "1.2.3",
  description: "Demo tools",
  tools: demoTools,
  commands: [gzipMagic],
  mcp: true,
  default: "measure",
  fallback: "echo",
  expected: (error) => error instanceof DemoError,
});
