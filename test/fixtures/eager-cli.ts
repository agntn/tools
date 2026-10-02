// citty loads here, before runCli can set NO_COLOR, as in a package whose own commands import it.
import "citty";

import { runCli } from "../../src/cli.ts";
import { demoTools } from "./demo.ts";

await runCli({ name: "demo", version: "1.2.3", description: "Demo tools", tools: demoTools });
