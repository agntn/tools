# AGENTS.md

`@agntn/tools`: one tool definition for MCP, Pi, OMP and the AI SDK. Keep this file updated with project status.

## Status

- Spike, not published, no remote. Go/no-go verified on `_template` (worktree `/var/tmp/agntn-spike/_template`, branch `spike/agntn-tools`), installed from a packed tarball.
- Verified in real hosts (2026-09-30): compiled OMP 18.4.4 and Pi 0.99.1 load the adapters from `node_modules`, keep `pattern` in the wire schema, reject a pattern mismatch, an over-long value and an extra key both in the host and in the core, and render through the real OMP theme. MCP over stdio (`dist/cli.mjs mcp`) and the AI SDK (`asSchema(...).validate`, `toModelOutput`) pass the same cases. `_template` keeps its 33 existing tests green.
- OMP startup: extension on the adapter, median 1.018 s against 0.984 s for the old `_template` extension (hyperfine, 40 runs, within noise).
- Open before a first release: 23 oxlint findings (`prefer-readonly-parameter-types` on TypeBox and host types, complexity of `assertSchema` and `validateInput`, JSDoc), README, a parity test helper for consumers, migration of a second package (hashes: 4 tools on all 4 surfaces).

## Decisions and evidence

- **Author schemas with `Type` from `@agntn/tools`, never `import { Type } from "typebox"`.** OMP's loader rewrites the bare `typebox` specifier across the extension graph to its omptype facade (`extensibility/plugins/legacy-pi-compat.ts`, `TYPEBOX_SPECIFIER_FILTER`), whose schemas are functions. `Value.Check` from the unremapped `typebox/value` then accepts any value, so validation silently vanished in the first probe. `defineTool` throws on a callable schema.
- **TypeBox is bundled into `dist`** (devDependency, one 265 KB chunk). Unbundled, its 688 modules each pass the OMP loader: +200 ms per OMP start (median 1.196 s vs 0.996 s); bundled +20 ms. A bundled copy also has no bare `typebox` import left to remap.
- **OMP gets the schema through `pi.typebox.Type.Unsafe(json)`.** The host build validates the raw JSON Schema with its full validator and emits it verbatim; standalone omptype `Unsafe` validates nothing, so the OMP test double emulates the host with TypeBox.
- **The core validates on every surface** (`invokeTool`), because a host may skip validation and OMP's omptype drops `pattern`.
- **OMP renderers get the host `Text` injected** by the extension; the adapter imports only types from `@oh-my-pi/pi-coding-agent`.
- **Pi failures throw by default** (`failures: "throw"`): Pi up to 0.98 treats a returned `isError` as success. `"return"` needs a peer range of `>=0.99.0`.
- **MCP stays on the low-level `Server`**: `McpServer.registerTool` needs Standard Schema, which TypeBox 1.x does not implement.
- Terminal and error text go through `sanitizeLine`: `stripVTControlCharacters` first (the family convention), then `Cc`, `Cf`, `Zl`, `Zp` to spaces.

## Stack

Node.js >= 24, TypeScript (strict), obuild, vitest, oxlint + oxfmt through `@agntn/ox`, pnpm.

## Structure

```
src/index.ts  - core: defineTool, Type, validateInput, invokeTool, sanitizeLine
src/mcp.ts    - createMcpServer
src/pi.ts     - registerPiTools
src/omp.ts    - registerOmpTools
src/ai.ts     - toAiTools
test/         - core, MCP and AI SDK adapter tests
```
