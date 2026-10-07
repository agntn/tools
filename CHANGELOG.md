# Changelog

## v0.2.1

[compare changes](https://github.com/agntn/tools/compare/v0.2.0...v0.2.1)

### 🚀 Enhancements

- Let a tool read the host context ([#50](https://github.com/agntn/tools/pull/50))
- Export `sanitizeText` from the core ([#54](https://github.com/agntn/tools/pull/54))
- Add CLI short flags and rest words ([#55](https://github.com/agntn/tools/pull/55))
- Read dashed words as CLI positionals ([#59](https://github.com/agntn/tools/pull/59))
- Let a package command write raw bytes ([#61](https://github.com/agntn/tools/pull/61))
- Add MCP icons and server description ([#64](https://github.com/agntn/tools/pull/64))

### 🩹 Fixes

- Read CLI numbers as written ([#60](https://github.com/agntn/tools/pull/60))

### ❤️ Contributors

- Ori
- Aeitwoen

## v0.2.0

[compare changes](https://github.com/agntn/tools/compare/v0.1.1...v0.2.0)

### 🚀 Enhancements

- Seat OMP tools in the top-level list ([#38](https://github.com/agntn/tools/pull/38))
- **pi:** Draw the call line OMP already gets ([#39](https://github.com/agntn/tools/pull/39))
- **pi:** Ask before a tool writes ([#40](https://github.com/agntn/tools/pull/40))
- **mcp:** Serve tools without a Server ([#42](https://github.com/agntn/tools/pull/42))
- Let a slow tool show it's still alive ([#43](https://github.com/agntn/tools/pull/43))
- Serve tools through h3-mcp ([#47](https://github.com/agntn/tools/pull/47))

### 🩹 Fixes

- Refuse twin tool names on every host ([#46](https://github.com/agntn/tools/pull/46))

### 📖 Documentation

- Give the CLI a page of its own ([#48](https://github.com/agntn/tools/pull/48))

### 🏡 Chore

- ⚠️  Require Node.js 26 ([#44](https://github.com/agntn/tools/pull/44))

#### ⚠️ Breaking Changes

- ⚠️  Require Node.js 26 ([#44](https://github.com/agntn/tools/pull/44))

### ❤️ Contributors

- Ori
- Aeitwoen

## v0.1.1

[compare changes](https://github.com/agntn/tools/compare/v0.1.0...v0.1.1)

### 🚀 Enhancements

- **mcp:** Keep the server title and website ([#36](https://github.com/agntn/tools/pull/36))

### 🩹 Fixes

- **pi:** Stop turning Pi 1.0 away at install ([#30](https://github.com/agntn/tools/pull/30))
- **release:** Let Publish outlive autofix ([#33](https://github.com/agntn/tools/pull/33))
- Ship TypeBox types tsc actually accepts ([#37](https://github.com/agntn/tools/pull/37))

### 🏡 Chore

- Apply automated updates ([6bb14b3](https://github.com/agntn/tools/commit/6bb14b3))

### ❤️ Contributors

- Aeitwoen ([@aeitwoen](https://github.com/aeitwoen))
- Ori ([@oritwoen](https://github.com/oritwoen))

## v0.1.0

### 🚀 Enhancements

- Spike shared tool definitions for MCP, Pi, OMP and AI SDK ([2b35628](https://github.com/agntn/tools/commit/2b35628))
- Take the hashes error format, typed AI SDK tools and TypeBox types ([7f27b68](https://github.com/agntn/tools/commit/7f27b68))
- Serve MCP through SDK v2 ([5bc22d9](https://github.com/agntn/tools/commit/5bc22d9))
- Pass host result renderers through, refuse a text field in AI details ([8633795](https://github.com/agntn/tools/commit/8633795))
- **docs:** Add the tools.agntn.dev site ([36a18d3](https://github.com/agntn/tools/commit/36a18d3))
- **docs:** Serve the pages over mcp ([ba27814](https://github.com/agntn/tools/commit/ba27814))
- Add a cli adapter ([#17](https://github.com/agntn/tools/pull/17))
- Put the tool title in MCP annotations ([#26](https://github.com/agntn/tools/pull/26))

### 🩹 Fixes

- Add the AI details text guard the previous commit tested ([42959b3](https://github.com/agntn/tools/commit/42959b3))
- **docs:** Make the hero instrument a wide dossier with the dialect map ([93474d8](https://github.com/agntn/tools/commit/93474d8))
- **docs:** Polish instruments against the design system ([a5f7f73](https://github.com/agntn/tools/commit/a5f7f73))
- **docs:** Light the preset chip for a deep link ([b7ef270](https://github.com/agntn/tools/commit/b7ef270))
- Name the stray key in a nested object ([#25](https://github.com/agntn/tools/pull/25))
- Take the square out of escape stripping ([#27](https://github.com/agntn/tools/pull/27))

### 💅 Refactors

- Pass lint, check record values in schemas ([11d208b](https://github.com/agntn/tools/commit/11d208b))
- Keep node:util out of the core so it runs in a browser ([90907ed](https://github.com/agntn/tools/commit/90907ed))

### 📖 Documentation

- Record the hashes migration and its decisions ([11755e9](https://github.com/agntn/tools/commit/11755e9))
- Drop the removed toModelOutput from the status ([8db50c7](https://github.com/agntn/tools/commit/8db50c7))
- Record the books migration ([e7131b9](https://github.com/agntn/tools/commit/e7131b9))
- Rewrite the README in the family shape ([53b0e8f](https://github.com/agntn/tools/commit/53b0e8f))
- Record the tools.agntn.dev deployment ([d6db81f](https://github.com/agntn/tools/commit/d6db81f))
- Record the first release ([07b371c](https://github.com/agntn/tools/commit/07b371c))
- Record the merged cli adapter ([671e8de](https://github.com/agntn/tools/commit/671e8de))

### 📦 Build

- Lint, format and test on Vite+, keep obuild ([af83a85](https://github.com/agntn/tools/commit/af83a85))

### 🏡 Chore

- Add repository metadata, CI and renovate ([9281646](https://github.com/agntn/tools/commit/9281646))
- Mark the escape pattern's control characters as intended ([c4e4216](https://github.com/agntn/tools/commit/c4e4216))
- **docs:** Bind the eu d1 databases ([1c5c304](https://github.com/agntn/tools/commit/1c5c304))
- Prepare the first npm release ([0c9499f](https://github.com/agntn/tools/commit/0c9499f))

### ❤️ Contributors

- Aeitwoen ([@aeitwoen](https://github.com/aeitwoen))
- Ori ([@oritwoen](https://github.com/oritwoen))
- Oritwoen ([@oritwoen](https://github.com/oritwoen))
