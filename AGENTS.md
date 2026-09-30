# AGENTS.md

`@agntn/tools`: one tool definition for MCP, Pi, OMP and the AI SDK. Keep this file updated with project status.

## Status

- Spike, not published, no remote. Go/no-go verified on `_template` (worktree `/var/tmp/agntn-spike/_template`, branch `spike/agntn-tools`), installed from a packed tarball.
- Verified in real hosts (2026-09-30): compiled OMP 18.4.4 and Pi 0.99.1 load the adapters from `node_modules`, keep `pattern` in the wire schema, reject a pattern mismatch, an over-long value and an extra key both in the host and in the core, and render through the real OMP theme. MCP over stdio (`dist/cli.mjs mcp`) and the AI SDK (`asSchema(...).validate`, then `execute`) pass the same cases. `_template` keeps its 33 existing tests green.
- OMP startup: extension on the adapter, median 1.018 s against 0.984 s for the old `_template` extension (hyperfine, 40 runs, within noise).
- hashes migrated (2026-09-30; worktree `/var/tmp/agntn-spike/hashes`, branch `spike/agntn-tools`, commit `fe4c884`): 4 tools on MCP, Pi, OMP and AI SDK from one definition each, 213 lines added and 698 removed, zod dropped as a direct dependency (MCP SDK v2 still pulls it in). All 208 existing tests pass; lint and typecheck clean. Real hosts, checkout and packed tarball in a clean consumer: OMP 18.4.4 and Pi 0.99.1 give the same answers, executor errors, core validation and host validation; MCP over stdio returns the exact multi-line error the hashes test pins. OMP startup median 0.980 s against 0.981 s on hashes `main`.
- MCP SDK v2 (2026-09-30): the adapter moved from `@modelcontextprotocol/sdk` 1.x to `@modelcontextprotocol/server` 2.2.0, hashes with it (commit on the same branch). All 208 hashes tests pass. Against the published `@agntn/hashes` 0.4.0 (SDK 1.30.1, no `@agntn/tools`): production install 95 packages and 33.4 MB down to 7 and 24.7 MB; MCP cold start to the `tools/list` answer, median 330 ms down to 184 ms (hyperfine, 40 runs, raw JSON-RPC over stdio). Both numbers are the whole migration, not the SDK alone. SDK v1 1.30.1 and v2 2.2.0 clients get identical answers over stdio from the packed server, including the multi-line validation error, `toString` as an unknown tool and an escaped hostile tool name.
- Lint clean (2026-09-30): `prefer-readonly-parameter-types` allows `ToolDefinition`, `ToolCallContext`, `ToolResult`, `OmpToolOptions` and the host types, as hashes does. No shared parity test helper: every adapter takes the same definition list, so schemas and descriptions cannot drift between surfaces; a package passing one surface a different list is caught by its own tool-name tests (hashes: `registers the four hash tools`).
- Remote: `agntn/tools` (private, like `agntn/ox`), CI on Node 24 and 26. `_template` is on MCP SDK v2 on its spike branch.
- books migrated (2026-09-30; worktree `/var/tmp/agntn-spike/books`, branch `spike/agntn-tools`, commit `6a92d9f`), with two decisions from Ori: every surface returns the `core/format.ts` text with the data as `details` (MCP used to return raw JSON, the AI SDK its own objects), and the broken OMP extension is fixed in the migration. On `main` the OMP extension does not load in compiled OMP 18.4.4 (`Cannot find package '@oh-my-pi/pi-tui'`, from `renderStatusLine` of `/tui`), and its test mocked `/tui` so nothing caught it; now OMP and Pi give identical answers, checkout and packed. MCP on `main` answered `toString` as "Tool toString disabled" and echoed a raw tool name (v1 `McpServer`); both gone. Production install 110 packages and 29.8 MB down to 22 and 23.0 MB; MCP cold start and OMP startup unchanged within noise. 179 tests pass.
- Docs live at tools.agntn.dev (2026-09-30): Worker `agntn-tools`, D1 `agntn-tools` and `agntn-tools-preview` in the EU jurisdiction, Workers Builds from `/docs` on `main` (`pnpm run build`, `npx wrangler deploy`), same trigger as puzzles. A clean clone builds with only `docs/` installed.
- Open before a first release: a first publish (npm), then the other packages.

## Decisions and evidence

- **Author schemas with `Type` from `@agntn/tools`, never `import { Type } from "typebox"`.** OMP's loader rewrites the bare `typebox` specifier across the extension graph to its omptype facade (`extensibility/plugins/legacy-pi-compat.ts`, `TYPEBOX_SPECIFIER_FILTER`), whose schemas are functions. `Value.Check` from the unremapped `typebox/value` then accepts any value, so validation silently vanished in the first probe. `defineTool` throws on a callable schema.
- **TypeBox is bundled into `dist`** (devDependency, one 265 KB chunk). Unbundled, its 688 modules each pass the OMP loader: +200 ms per OMP start (median 1.196 s vs 0.996 s); bundled +20 ms. A bundled copy also has no bare `typebox` import left to remap.
- **OMP gets the schema through `pi.typebox.Type.Unsafe(json)`.** The host build validates the raw JSON Schema with its full validator and emits it verbatim; standalone omptype `Unsafe` validates nothing, so the OMP test double emulates the host with TypeBox.
- **Schema types come from `@agntn/tools` too** (`export type * from "typebox"`): with TypeBox bundled, a consumer that exports a definition can name every type its schema uses only through this package, and its own `typebox` types would be a second, mismatched copy.
- **Executors load lazily in the consumer:** `execute: async (p) => (await loadOperations()).op(p)` with a cached dynamic import, so the extensions register tools without loading the library (hashes: only the contract and `@agntn/tools` are static imports of `dist/tools.mjs`).
- **Validation errors are one failure per line** (format taken from agntn/hashes): an unknown key names itself with the keys the tool takes, an enum failure lists the allowed values. `ToolInputError.lines` carries them, and MCP `errorResult` sanitizes each line alone, so a newline inside an executor or provider message still becomes a space.
- **AI SDK output is `{ ...details, text }`** and a failure throws (hashes' contract); `toAiTool` keeps input and details types, but a consumer annotates exported tools itself.
- **Test double for `pi.typebox`:** standalone omptype `Type.Unsafe` returns one shared schema object for every call, so the double wraps each document in its own callable; patching the shared one made every tool validate with the last schema registered.
- **The core validates on every surface** (`invokeTool`), because a host may skip validation and OMP's omptype drops `pattern`.
- **Hosts' own result renderers pass through** (`renderers[name].renderResult` for Pi and OMP): books keeps its bounded preview of long output. The OMP status line (`describeCall`, `describeResult`) stays the adapter's.
- **AI SDK details must not have a `text` field**: `{ ...details, text }` would overwrite one of them, so the adapter throws. books renamed its slice to `slice`.
- **OMP renderers get the host `Text` injected** by the extension; the adapter imports only types from `@oh-my-pi/pi-coding-agent`.
- **Pi failures throw by default** (`failures: "throw"`): Pi up to 0.98 treats a returned `isError` as success. `"return"` needs a peer range of `>=0.99.0`.
- **MCP uses SDK v2's low-level `Server`, not `McpServer`.** `McpServer.registerTool` in 2.2.0 takes any Standard Schema with JSON Schema, so TypeBox would fit, but a probe showed it answers `toString`, `constructor` and `__proto__` with "Tool toString disabled" (a lookup that reaches `Object.prototype`), echoes a raw tool name with a newline and ESC into its JSON-RPC error, joins validation failures into one line and passes a thrown message with its newline unsanitized. `Server` is `@deprecated` in v2 as in v1. v2 over v1 anyway: 2 runtime dependencies (`zod`, `@modelcontextprotocol/core`) instead of 17 (express, hono, cors, ajv, jose and more). The handler's abort signal is `ctx.mcpReq.signal`; stdio is `@modelcontextprotocol/server/stdio`, the test client `@modelcontextprotocol/client`.
- Terminal and error text go through `sanitizeLine`: `stripVTControlCharacters` first (the family convention), then `Cc`, `Cf`, `Zl`, `Zp` to spaces.

## Stack

Toolchain variant, chosen by Ori (2026-09-30): **obuild + Vite+**. obuild builds (`build.config.ts`, TypeBox bundled into `dist/_chunks/libs/typebox.mjs`); Vite+ 1.0 lints, formats and tests (`vp lint`, `vp fmt`, `vp test`, test API from `vite-plus/test`), configured in one `vite.config.ts` on `@agntn/ox`. `vite` and `vite-plus` come from the pnpm catalog with the `vite` override, as in `_template-vite-plus`; CI installs through `voidzero-dev/setup-vp`. Switching variants did not change `dist` (byte-identical build), and a planted `prefer-readonly-parameter-types` violation proves the type-aware rules run under `vp lint`.

Node.js >= 24, TypeScript (strict), pnpm.

## Structure

```
src/index.ts  - core: defineTool, Type, validateInput, invokeTool, sanitizeLine
src/mcp.ts    - createMcpServer
src/pi.ts     - registerPiTools
src/omp.ts    - registerOmpTools
src/ai.ts     - toAiTools
test/         - core, MCP and AI SDK adapter tests
```
