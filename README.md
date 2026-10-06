# @agntn/tools

[![npm version](https://npmx.dev/api/registry/badge/version/@agntn/tools)](https://npmx.dev/package/@agntn/tools)
[![npm downloads](https://npmx.dev/api/registry/badge/downloads/@agntn/tools)](https://npmx.dev/package/@agntn/tools)
[![license](https://npmx.dev/api/registry/badge/license/@agntn/tools)](https://npmx.dev/package/@agntn/tools)
[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/agntn/tools)

🧰 Four hosts, one definition. You write the tool once. MCP, Pi, OMP and the AI SDK each get it the way they like it.

Want to watch it happen? [tools.agntn.dev](https://tools.agntn.dev) has the docs and a playground. One call, four hosts, all live in your tab.

## Why?

MCP wants an `inputSchema`. Pi wants `parameters` and a prompt snippet. OMP swaps your TypeBox for its own. The AI SDK wants yet another schema. So every tool lived in four files, and four files drift. Now it lives in one.

## ✨ Features

- 📝 **One definition.** Name, schema, effect and `execute`. That's the whole tool.
- 🔌 **Four host adapters.** `createMcpServer`, `registerPiTools`, `registerOmpTools` and `toAiTool`. One call each.
- 🛡️ **Validation on every host.** The core checks each call before your code runs. Even when the host skips its own check.
- 🗣️ **Errors a model can use.** A misspelled key names itself and the keys you do take. An enum lists its values.
- 🧵 **One line per error.** Newlines, escape codes and bidi tricks in echoed text get flattened. No forged lines.
- 🪤 **The OMP TypeBox trap, defused.** TypeBox is bundled, so OMP has nothing left to rewrite behind your back.
- 🧪 **Schema rules at definition time.** An open object or a union of literals fails in `defineTool`. Not three weeks later in a model's hands.
- ⏳ **Progress that gets somewhere.** `progress?.("still at it")` turns into `onUpdate` in Pi and OMP and `notifications/progress` in MCP. A slow call stops looking like a dead one.
- ⌨️ **A CLI on the side.** `runCli` turns the same tools into commands, no CLI library needed. Flags come from the schema. A hint adds positionals and stdin.
- 🌐 **Runs anywhere.** No `node:*` import in the core or the host adapters. The docs site runs them in a browser tab. The CLI is the one Node part, as a CLI should be.

## 📦 Install

```bash
pnpm add @agntn/tools
```

Node.js 26 or newer. Then add the hosts you serve. Each one is an optional peer.

## 🚀 First call

```ts
import { defineTool, Type } from "@agntn/tools";
import { createMcpServer } from "@agntn/tools/mcp";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";

const slugTool = defineTool({
  name: "text_slug",
  title: "Text Slug",
  description: "Turn a title into a lowercase URL slug.",
  effect: "read",
  input: Type.Object({ text: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
  execute: ({ text }) => {
    const slug =
      text
        .toLowerCase()
        .match(/[a-z0-9]+/g)
        ?.join("-") ?? "";
    return { content: [{ type: "text", text: slug }], details: { slug } };
  },
});

const server = createMcpServer({ name: "slugs", version: "1.0.0" }, [slugTool]);
const client = new Client({ name: "demo", version: "1.0.0" });
const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(serverSide), client.connect(clientSide)]);

console.log(await client.callTool({ name: "text_slug", arguments: { text: "Hello, World" } }));
console.log(await client.callTool({ name: "text_slug", arguments: { txt: "Hello, World" } }));
```

```text
{ content: [ { type: 'text', text: 'hello-world' } ] }
{
  content: [
    {
      type: 'text',
      text: 'Invalid arguments: unknown property "txt"; takes text\n' +
        'Invalid arguments at /: must have required properties text'
    }
  ],
  isError: true
}
```

The typo never reached `execute`. The model gets told what it did wrong and what the tool takes. Pi, OMP and the AI SDK hand it the same two lines, only through their own error channel. [Validation and errors](https://tools.agntn.dev/guide/validation) has the table.

## 🤖 Hosts

| Host   | Adapter                                    | Peer                              |
| ------ | ------------------------------------------ | --------------------------------- |
| MCP    | `createMcpServer` from `@agntn/tools/mcp`  | `@modelcontextprotocol/server`    |
| Pi     | `registerPiTools` from `@agntn/tools/pi`   | `@earendil-works/pi-coding-agent` |
| OMP    | `registerOmpTools` from `@agntn/tools/omp` | `@oh-my-pi/pi-coding-agent`       |
| AI SDK | `toAiTool` from `@agntn/tools/ai`          | `ai`                              |
| CLI    | `runCli` from `@agntn/tools/cli`           | none                              |

Install only what you ship. An MCP server doesn't need the AI SDK, and nobody makes it pretend. Every host has its own page with the gotchas: [tools.agntn.dev/hosts](https://tools.agntn.dev/hosts).

## 🚫 What this does not do

It doesn't run your server or pick a transport. Stdio, HTTP, in memory, your call. Unless you ask `runCli` for its `mcp` command. That one is stdio. And it isn't a schema library. TypeBox does that part, this just makes sure every host sees the same one.

## 🛠️ Development

```bash
pnpm install
pnpm lint         # vp lint and vp fmt --check
pnpm typecheck    # tsc over the source and the tests
pnpm test         # vp test run
pnpm build        # obuild, TypeBox bundled into dist
```

## 💛 Thanks

Written with a lot of help from [Claude for Open Source](https://claude.com/contact-sales/claude-for-oss) and [Codex for Open Source](https://developers.openai.com/community/codex-for-oss). Both keep open source maintainers going for free. Cheers <3

## 📄 License

[MIT](./LICENSE)
