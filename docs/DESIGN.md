# Design system

The shared rules (direction, color roles, type, the `console-*` grammar, hero, docs chrome, density, motion, checks) live in the one agntn design system document, kept with the agntn skills until it ships in the shared package. This file records only what tools owns and where it departs from the shared rules. It does not repeat them.

The instruments tools owns:

| Instrument | Where | Object |
| --- | --- | --- |
| [LandingHero.vue](app/components/content/LandingHero.vue) | landing, first screen | hero zone, circuit `register` into the host walk |
| [LandingHosts.vue](app/components/content/LandingHosts.vue) | under the hero | `text_slug` registered by each adapter in turn: the dialect map, what that host holds, the full registration in the dialog |
| [LandingDefinition.vue](app/components/content/LandingDefinition.vue) | "One file, zero dialects" | `demo-tool.ts` itself through `?raw`, `execute` folded to its signature |
| [LandingValidation.vue](app/components/content/LandingValidation.vue) | "Same mistake, same answer, four hosts" | one call per sample: the verdict with the core's line, then each host's channel and text |
| [LandingTrap.vue](app/components/content/LandingTrap.vue) | "The OMP trap, already sprung" | the bare `typebox` import before and after, with the measured start cost |
| [LandingSanitize.vue](app/components/content/LandingSanitize.vue) | "Hostile text stays on one line" | a hostile string in, `sanitizeLine` out |
| [LandingStart.vue](app/components/content/LandingStart.vue) | closing section | install, notes, the wiring as a file |
| [HostFacts.vue](app/components/content/HostFacts.vue) | every host page (`::host-facts`) | host dossier: ID bar with position, reticle, readout, access leads, full registration |
| [HostRoster.vue](app/components/content/HostRoster.vue) | `/hosts` (`::host-roster`) | roster of the four hosts on `UTable`, sortable |
| [ToolsPlayground.vue](app/components/content/ToolsPlayground.vue) | `/playground` under the hero zone | JSON arguments in, each host's channel and text out |
| [Landing.takumi.vue](app/components/OgImage/Landing.takumi.vue), [Docs.takumi.vue](app/components/OgImage/Docs.takumi.vue) | OG images | the hero zone in 1200 by 600; a docs page as one instrument with the hosts as chips |

Every value an instrument shows comes from the adapters in `../src`, run in [hosts.ts](app/utils/hosts.ts) against the tool in [demo-tool.ts](app/utils/demo-tool.ts): Pi and OMP through host doubles that record the registration, MCP through a real server and client on an in-memory transport, the AI SDK through `toAiTool` and `asSchema`. Only the OMP start cost in `LandingTrap.vue` is a measured literal.

## Anatomy

- **Host walk.** A `console-wide` dossier as wide as the hero zone, like the siblings' hero instruments. Bar `Call <adapter>(…, [text_slug])` with the adapter rolling, meta `<peer> · 02 / 04`. The subject band's left column holds the host (reticle, `Host / <short>`, name, one sentence; every host's name block hidden in the same cell, so the band keeps one height) and under it the dialect map: rule `Dialect [ one tool, the field each host puts it in ]`, a column per host, a row per idea (name, label, schema, effect, prompt, run), each cell the field that host's registration really uses or `—`, the current host's column lit. Readout: four rows from the registration, stretched to the map's height while side by side, and a tick per host with the current one open. `03 Full registration` opens the object the host got, functions named. Footer: link to the host page, previous and next.
- **Validation.** Bar `Call text_slug(<args>)`, meta the sample's label. Subject band on the crosses grid: a reticle with the verdict's icon, `Core / <refused · isError · ok>`, the verdict's name and one line under it, the core's lines or the executor's `isError` text in the danger color, else `Nothing wrong with it.`. Readout: one row per host, the channel word (red for a failure) then the text. `03 Full tool response` is the MCP text.
- **Host dossier.** ID bar with the key and `03 / 04`, meta the peer package. Subject: reticle, `Host / <short>`, name, blurb. Readout from the registration. Band `Access [ import · peer · adapter ]` as leads: the import, the peer with its range from the root `package.json`, how a failure travels. Then `03 Full registration`.
- **Roster.** Columns host (glyph, name, boxed key), adapter, peer with range, and the failure channel behind a leader.
- **Playground.** Chips for the landing's samples and a few more as `UButton` variant `chip`, the arguments in a `UTextarea` variant `none`, a `UAlert` while the text isn't JSON. One row per host: boxed glyph, name, a `UBadge` with the channel, the text in full. State lives in `?args=`.

## Motion

| Change | Motion |
| --- | --- |
| landing sample advances (4.2 s, paused on hover and focus) | ruler cursor once, scan and reticle arcs, readout rows slide in, the adapter or call rolls, circuit runs once |
| playground arguments change | cursor loops while the four hosts answer, 250 ms after typing stops |
| reduced motion | no walk; previous and next still work |

## Differences

Departures from the shared rules, recorded for the shared package:

- The hero instrument walks hosts, not records. The subject of this package is one tool as four hosts see it, so each step is a host.
- One clock drives both the host walk (four steps) and the validation samples (five), so the two panels move together without sharing a count.
- The landing reads the hosts through `useAsyncData`, computed at prerender and shipped in the payload, so the page doesn't load the MCP SDK or the AI SDK just to print them. The playground loads both on demand.
- The danger color `#ff7b72` marks the core's rejection lines and failure channels, which the shared rules reserve for caution and errors. That's what they are here.
- The OG images ship local Figtree and Fira Code TTFs, the keys mechanism.
- There's no `public/image.png`, since `package.json` points Pi at no image.

## Checks

Beyond the shared checks: `/`, `/hosts`, `/hosts/omp` and `/playground` with a deep link (`?args={"text":"¯\\_(ツ)_/¯"}` shows three channels) at 1440, 1024 and 390 px, and no horizontal scroll at 320 px.
