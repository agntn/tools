# docs/

Docus site for `@agntn/tools` at tools.agntn.dev. Markdown lives in `content/`. The landing, the host pages and the playground run the library's adapters in the page, there's no server API.

## Layout

```
docs/
├── DESIGN.md                      # the instruments this site owns and where it departs from the agntn design system
├── nuxt.config.ts                 # extends: ['docus'], cloudflare_module preset (Workers), @agntn/tools and its subpaths aliased to ../src
├── shiki-theme.ts                 # code block theme, every colour a --shiki-token-* variable from app.css
├── app/app.config.ts              # title, github, theme, the Nuxt UI variants in the instrument grammar
├── app/app.css                    # theme tokens, the shared `console-*` and `hero-*` grammar, `tools-*` classes
├── app/components/                # Docus overrides: header, tabs, sidebar, table of contents, page links, surround, callout
├── app/components/content/        # MDC components (`::landing-home`, `::host-facts`, `::host-roster`), the landing instruments, Prose* overrides, ToolsPlayground
├── app/components/OgImage/        # Docs.takumi and Landing.takumi override the Docus OG templates
├── app/assets/fonts.css           # @font-face for the TTFs served from public/fonts (site and OG images)
├── app/composables/               # useLandingHosts (one clock for every landing panel), useSubNavigation, useCopied, useRosterFlip
├── app/utils/demo-tool.ts         # text_slug, the one tool every panel registers and calls
├── app/utils/hosts.ts             # the four hosts, their metadata, registrations and calls through the real adapters
├── app/pages/playground.vue       # playground, own route outside the docs layout, its own useSeo and OG image
├── server/mcp/index.ts            # the Docus MCP handler at /mcp, with a description and the site's icons
├── server/routes/sitemap.xml.ts   # Docus sitemap plus the Vue pages it cannot see
├── public/                        # fonts, favicon.svg and the icons and manifest cut from it
├── content/index.md               # landing
├── content/1.guide/               # getting started, defining tools, validation and errors, the CLI, moving a package over
└── content/2.hosts/               # the roster, one page per host
```

## Commands

```bash
pnpm install          # from docs/, the repo root needs no install or build first
pnpm dev              # http://localhost:3000
pnpm build            # Cloudflare Workers output in .output/, content routes prerendered
pnpm deploy           # build, then wrangler deploy to tools.agntn.dev
```

Deployment: Workers Builds with root directory `docs`. It installs `docs/` and nothing else, and that's enough, because the library comes from `../src`. Node.js comes from `.node-version` at the repo root: Workers Builds never reads `engines`, and without that file the site quietly builds on the image default (24.18.0 on the last build without it). Nitro preset `cloudflare_module`. Nuxt Content wants a D1 binding named `DB`; `wrangler.jsonc` names the database `agntn-tools` and still needs its `database_id` once the database exists.

`@agntn/tools` and its subpaths (`/mcp`, `/pi`, `/omp`, `/ai`) are aliases in `nuxt.config.ts` for the files in `../src`. The core and the adapters import `typebox`, `@modelcontextprotocol/server`, `@modelcontextprotocol/client` and `ai`, so each is a dependency here, pinned to the root's version, and listed in `vite.resolve.dedupe` and `vite.optimizeDeps.include`: Vite resolves a bare import in `../src` from the repo root upward, never from `docs/node_modules`. A new npm import under `src/` needs the same three entries or it breaks the deploy. None of `src/` imports `node:*`, which is what lets the browser run it; `test/tools.test.ts` in the root keeps it that way.

Two resolution traps, both because the repo root is its own pnpm workspace:

- `pnpm-workspace.yaml` sets `shamefullyHoist: true`. Without it `docs/node_modules` holds only direct dependencies, Node walks up to the root `node_modules`, and the server bundle can end up with a second copy of Vue.
- `nuxt.config.ts` pins `workspaceDir` to `docs/`, disables devtools and telemetry, and adds `../src` to `vite.server.fs.allow`, since `pnpm dev` couldn't load the library otherwise.

## Live values

- Every host panel comes from the adapters themselves. `hosts.ts` registers `text_slug` on a Pi double and an OMP double that record what they get, builds a real MCP server and lists it through a real client on an in-memory transport, and wraps the tool with `toAiTool`. Nothing is a hand-written copy of what a host receives.
- The landing reads `hostViews()` and the answers to `CASES` through `useAsyncData`: computed at prerender, shipped in the payload. The heavy imports (`@agntn/tools/mcp`, `@modelcontextprotocol/client`, `@agntn/tools/ai`, `ai`) stay dynamic inside those functions, so a page that only lists the hosts doesn't bundle the SDKs.
- `LandingDefinition.vue` imports `demo-tool.ts?raw`, so the file on the landing is the file that runs.
- The samples are deterministic, so SSR and the client agree. No `Math.random`, no clock inside a computed.
- `LandingTrap.vue` holds the one measured literal: OMP start cost on OMP 18.4.4, median of 40 starts, and the 688 TypeBox modules. Measure again before changing it.
- `ToolsPlayground.vue` reads the deep link through a watcher registered in `onMounted` that stops after its first change, plus a direct read when the query is already there. A prerendered page hydrates with an empty `route.query` and Nuxt restores the address afterwards.

## SEO

- `seo.schema` in `app/app.config.ts` emits the landing JSON-LD: `WebSite`, the agntn `Organization` as publisher, and a free `SoftwareApplication` with `sameAs` on GitHub and npm.
- `server/routes/sitemap.xml.ts` wraps the Docus sitemap and appends the Vue pages listed in `PAGES`; a new page under `app/pages/` goes there too.
- `public/favicon.svg` is the source, the PNGs and the `.ico` are cut from it with ImageMagick.
- `/mcp` names `favicon.svg` and `icon-512.png` by their absolute URLs on tools.agntn.dev as its icons, so a connector card breaks quietly when either moves.

## OG images

- `app/components/OgImage/Docs.takumi.vue` and `Landing.takumi.vue` override the Docus templates and are rendered by Takumi at build time. Takumi has no CSS variables, so the theme colours are repeated there as literals.
- Descriptions go without commas and without a trailing period: Docus puts them in the OG file name, where a comma is a separator and `..png` is skipped without a word. A `: ` in a frontmatter description is a YAML mapping and the page vanishes from the prerender.

## Constraints

- Text a visitor types into the playground is rendered as text, through interpolation or a `<pre>`. Never `v-html`, never evaluate. `JSON.parse` is the only thing that reads it.
- Every behaviour a page describes is checked against `../src`. The host table on `/guide/validation` matches what the playground shows for the same arguments.
- The site makes no network request for its own work and stays that way. The MCP transport is in memory.
