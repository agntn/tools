# @agntn/tools

Declare a tool once and serve it on MCP, Pi, OMP and the AI SDK.

Not published yet.

```ts
import { defineTool, Type } from "@agntn/tools";

export const paths = defineTool({
  name: "template_paths",
  title: "Template Paths",
  description: "Resolve config, data and cache directories for an application.",
  effect: "read",
  input: Type.Object({ appName: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
  execute: ({ appName }) => templatePaths(appName),
});
```

Then `createMcpServer(info, tools)` from `@agntn/tools/mcp`, `registerPiTools(pi, tools)` from `/pi`, `registerOmpTools(pi, tools, { Text })` from `/omp` and `toAiTools(tools)` from `/ai`.

Build schemas with the `Type` exported here, not with `typebox` directly: OMP rewrites bare `typebox` imports to a different schema library.
