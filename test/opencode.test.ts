import type { Plugin } from "@opencode/plugin";
import type { Info, ToolContext } from "@opencode/plugin/promise/tool";
import { describe, expect, expectTypeOf, it } from "vite-plus/test";

import { defineTool, ToolDefinitionError, ToolInputError, Type, wireSchema } from "../src/index.ts";
import { registerOpencodeTools } from "../src/opencode.ts";

interface Asked {
  readonly sessionID: string;
  readonly agent?: string;
  readonly action: string;
  readonly resources: readonly string[];
  readonly save?: readonly string[];
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly source?: unknown;
}

interface Host {
  readonly ctx: Plugin.Context;
  readonly added: Info[];
  readonly asked: Asked[];
  readonly find: (name: string) => Info;
}

/* A plugin context with only the tool and permission halves, recording what reaches them. */
function host(answer: (asked: Asked) => Promise<void> = async () => {}): Host {
  const added: Info[] = [];
  const asked: Asked[] = [];
  /* The registered tool by name; a missing one fails the test. */
  const find = (name: string): Info => {
    const tool = added.find((entry) => entry.name === name);
    if (!tool) throw new Error(`${name} was not registered`);
    return tool;
  };
  const ctx = {
    tool: {
      transform: async (callback: (editor: Readonly<{ add: (tool: unknown) => void }>) => void) => {
        callback({ add: (tool) => added.push(tool as Info) });
        return { dispose: async () => {} };
      },
    },
    permission: {
      assert: async (input: Asked) => {
        asked.push(input);
        await answer(input);
      },
    },
  } as unknown as Plugin.Context;
  return { ctx, added, asked, find };
}

/* The context OpenCode hands one call, with its progress updates kept. */
function call(signal = new AbortController().signal): { context: ToolContext; updates: unknown[] } {
  const updates: unknown[] = [];
  const context = {
    sessionID: "ses_1",
    agent: "build",
    messageID: "msg_1",
    id: "call_1",
    signal,
    progress: async (update: unknown) => {
      updates.push(update);
    },
  } as unknown as ToolContext;
  return { context, updates };
}

let ran: string[] = [];

const echo = defineTool({
  name: "demo_echo",
  title: "Demo Echo",
  description: "Echo a word.",
  effect: "read",
  input: Type.Object({ word: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
  execute: ({ word }, { progress }) => {
    progress?.(`echoing ${word}`, { progress: 1, total: 2 });
    return { content: [{ type: "text", text: word }], details: { length: word.length } };
  },
});

const save = defineTool({
  name: "demo_save",
  title: "Demo Save",
  description: "Save a word.",
  effect: "write",
  input: Type.Object({ word: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
  execute: ({ word }) => {
    ran.push(word);
    return { content: [{ type: "text", text: `saved ${word}` }], details: {} };
  },
});

const sulk = defineTool({
  name: "demo_sulk",
  title: "Demo Sulk",
  description: "Answer with an error result.",
  effect: "read",
  input: Type.Object({}),
  execute: () => ({
    content: [{ type: "text", text: "no word today" }],
    details: { mood: "bad" },
    isError: true,
  }),
});

const pixel = defineTool({
  name: "demo_pixel",
  title: "Demo Pixel",
  description: "Draw one pixel.",
  effect: "read",
  input: Type.Object({}),
  execute: () => ({
    content: [
      { type: "text", text: "one pixel" },
      { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
    ],
    details: [1, 2],
  }),
});

const hush = defineTool({
  name: "demo_hush",
  title: "Demo Hush",
  description: "Say nothing.",
  effect: "read",
  input: Type.Object({}),
  execute: () => ({ content: [], details: undefined }),
});

const wipe = defineTool({
  name: "demo_wipe",
  title: "Demo Wipe",
  description: "Forget every word.",
  effect: "destructive",
  input: Type.Object({}),
  execute: () => ({ content: [{ type: "text", text: "gone" }], details: {} }),
});

const shell = defineTool({
  name: "demo_shell",
  title: "Demo Shell",
  description: "Run a command.",
  effect: "exec",
  input: Type.Object({}),
  execute: () => ({ content: [{ type: "text", text: "ran" }], details: {} }),
});

const tools = [echo, save, sulk, pixel, hush, wipe, shell];

describe("OpenCode adapter", () => {
  it("adds every tool under its own name, with the wire schema", async () => {
    const { ctx, added, find } = host();
    await registerOpencodeTools(ctx, tools);
    expect(added.map((tool) => tool.name)).toEqual(tools.map((tool) => tool.name));
    expect(find("demo_echo")).toMatchObject({
      description: "Echo a word.",
      input: wireSchema(echo),
    });
  });

  it("refuses two tools with one name before touching OpenCode", async () => {
    const { ctx, added } = host();
    await expect(registerOpencodeTools(ctx, [echo, echo])).rejects.toThrow(ToolDefinitionError);
    expect(added).toEqual([]);
  });

  it("runs a read without asking and keeps the details as metadata", async () => {
    const { ctx, asked, find } = host();
    await registerOpencodeTools(ctx, tools);
    const { context, updates } = call();
    const result = await find("demo_echo").execute({ word: "hi" }, context);
    expect(asked).toEqual([]);
    expect(result).toEqual({ content: [{ type: "text", text: "hi" }], metadata: { length: 2 } });
    expect(updates).toEqual([{ message: "echoing hi", progress: 1, total: 2 }]);
  });

  it("asks before a write, under the tool name, for this call", async () => {
    ran = [];
    const { ctx, asked, find } = host();
    await registerOpencodeTools(ctx, tools);
    const result = await find("demo_save").execute({ word: "hi" }, call().context);
    expect(asked).toEqual([
      {
        sessionID: "ses_1",
        agent: "build",
        action: "demo_save",
        resources: ["*"],
        save: ["*"],
        metadata: { input: { word: "hi" } },
        source: { type: "tool", messageID: "msg_1", id: "call_1" },
      },
    ]);
    expect(ran).toEqual(["hi"]);
    expect(result.content).toEqual([{ type: "text", text: "saved hi" }]);
  });

  it.each(["demo_wipe", "demo_shell"])("asks before %s too", async (name) => {
    const { ctx, asked, find } = host();
    await registerOpencodeTools(ctx, tools);
    await find(name).execute({}, call().context);
    expect(asked.map((request) => request.action)).toEqual([name]);
  });

  it("never runs a write OpenCode turned down", async () => {
    ran = [];
    const denied = new Error("denied by a rule");
    const { ctx, find } = host(async () => {
      throw denied;
    });
    await registerOpencodeTools(ctx, tools);
    await expect(find("demo_save").execute({ word: "hi" }, call().context)).rejects.toBe(denied);
    expect(ran).toEqual([]);
  });

  it("refuses bad arguments to a write before anyone is asked", async () => {
    const { ctx, asked, find } = host();
    await registerOpencodeTools(ctx, tools);
    await expect(find("demo_save").execute({ word: "" }, call().context)).rejects.toThrow(
      ToolInputError,
    );
    expect(asked).toEqual([]);
  });

  it("throws the text of an error result, so OpenCode records a failed call", async () => {
    const { ctx, find } = host();
    await registerOpencodeTools(ctx, tools);
    await expect(find("demo_sulk").execute({}, call().context)).rejects.toThrow("no word today");
  });

  it("sends an image as a data URI and wraps details that aren't an object", async () => {
    const { ctx, find } = host();
    await registerOpencodeTools(ctx, tools);
    const result = await find("demo_pixel").execute({}, call().context);
    expect(result).toEqual({
      content: [
        { type: "text", text: "one pixel" },
        { type: "file", uri: "data:image/png;base64,iVBORw0KGgo=", mime: "image/png" },
      ],
      metadata: { details: [1, 2] },
    });
  });

  it("answers an empty result with an empty string and no metadata", async () => {
    const { ctx, find } = host();
    await registerOpencodeTools(ctx, tools);
    expect(await find("demo_hush").execute({}, call().context)).toEqual({ content: "" });
  });

  it("keeps going when OpenCode drops a progress update", async () => {
    const { ctx, find } = host();
    await registerOpencodeTools(ctx, tools);
    const { context } = call();
    const failing = {
      ...context,
      signal: context.signal,
      progress: async () => {
        throw new Error("session closed");
      },
    } as unknown as ToolContext;
    const result = await find("demo_echo").execute({ word: "hi" }, failing);
    expect(result.content).toEqual([{ type: "text", text: "hi" }]);
  });

  it("lets go of a read once the call is stopped", async () => {
    const { ctx, find } = host();
    await registerOpencodeTools(ctx, tools);
    const stopped = new AbortController();
    stopped.abort(new Error("stopped by the user"));
    await expect(
      find("demo_echo").execute({ word: "hi" }, call(stopped.signal).context),
    ).rejects.toThrow("stopped by the user");
  });

  it("fits a promise plugin's setup", () => {
    expectTypeOf(registerOpencodeTools).parameter(0).toEqualTypeOf<Plugin.Context>();
    const plugin: Plugin.Plugin = {
      id: "demo",
      setup: (ctx) => registerOpencodeTools(ctx, tools),
    };
    expect(plugin.id).toBe("demo");
  });
});
