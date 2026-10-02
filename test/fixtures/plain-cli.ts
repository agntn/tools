// The demo tools without `default` or `fallback`, so every first word is a command word.
import { runCli } from "../../src/cli.ts";
import { demoTools } from "./demo.ts";

await runCli({ name: "demo", version: "1.2.3", description: "Demo tools", tools: demoTools });
