import { H3 } from "h3";
import { describe, expect, it } from "vite-plus/test";

import { createHttpHandler, type HttpHost } from "../src/http.ts";
import { defineTool, Type, validateInput, type ToolCallContext } from "../src/index.ts";
import { callTool } from "../src/mcp.ts";

const info = { name: "demo", version: "1.2.3" };

const echo = defineTool({
  name: "demo_echo",
  title: "Demo Echo",
  description: "Echo a word.",
  effect: "read",
  input: Type.Object({ word: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
  execute: ({ word }) => ({
    content: [{ type: "text", text: word }],
    details: { length: word.length },
  }),
});

let written: string[] = [];

const save = defineTool({
  name: "demo_save",
  title: "Demo Save",
  description: "Save a word.",
  effect: "write",
  input: Type.Object({ word: Type.String() }, { additionalProperties: false }),
  execute: ({ word }) => {
    written.push(word);
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

const crash = defineTool({
  name: "demo_crash",
  title: "Demo Crash",
  description: "Throw with a cause.",
  effect: "read",
  input: Type.Object({}),
  execute: () => {
    throw new Error("upstream\nforged line", { cause: new Error("socket hang up") });
  },
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
    details: {},
  }),
});

let seen: ToolCallContext | undefined;

const peek = defineTool({
  name: "demo_peek",
  title: "Demo Peek",
  description: "Read a header of the request.",
  effect: "read",
  input: Type.Object({}),
  execute: (_input, context) => {
    seen = context;
    const host = context.host as HttpHost | undefined;
    const agent = host?.http === true ? host.request.headers.get("x-agent") : null;
    return { content: [{ type: "text", text: agent ?? "nobody" }], details: {} };
  },
});

const stall = defineTool({
  name: "demo_stall",
  title: "Demo Stall",
  description: "Wait until cancelled.",
  effect: "read",
  input: Type.Object({}),
  execute: async (_input, { signal }) =>
    await new Promise<never>((_resolve, reject) => {
      signal?.addEventListener("abort", () => {
        reject(new Error("stalled out"));
      });
    }),
});

const huge = defineTool({
  name: "demo_huge",
  title: "Demo Huge",
  description: "Answer with a bigint in the details.",
  effect: "read",
  input: Type.Object({}),
  execute: () => ({ content: [{ type: "text", text: "big" }], details: { n: 2n ** 64n } }),
});

const bare = defineTool({
  name: "demo_bare",
  title: "Demo Bare",
  description: "Answer without details.",
  effect: "read",
  input: Type.Object({}),
  execute: () => ({ content: [{ type: "text", text: "bare" }], details: undefined }),
});

const tools = [echo, save, sulk, crash, pixel, peek, stall, huge, bare];
const handler = createHttpHandler(info, tools);

/* A POST of JSON text to one tool. */
function post(path: string, body: string, type = "application/json"): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": type },
    body,
  });
}

/* The status and parsed body of one answer. */
async function sent(request: Request): Promise<{ status: number; body: unknown }> {
  const response = await handler.fetch(request);
  expect(response.headers.get("content-type")).toMatch(/^application\/json/);
  return { status: response.status, body: await response.json() };
}

describe("HTTP adapter", () => {
  it("lists the read tools with their schemas and effects, and nothing that writes", async () => {
    const { status, body } = await sent(new Request("http://localhost/"));
    expect(status).toBe(200);
    expect(body).toMatchObject({ name: "demo", version: "1.2.3" });
    const listed = (body as { tools: { name: string }[] }).tools;
    expect(listed.map((tool) => tool.name)).toEqual([
      "demo_echo",
      "demo_sulk",
      "demo_crash",
      "demo_pixel",
      "demo_peek",
      "demo_stall",
      "demo_huge",
      "demo_bare",
    ]);
    expect(listed[0]).toEqual({
      name: "demo_echo",
      title: "Demo Echo",
      description: "Echo a word.",
      effect: "read",
      inputSchema: {
        type: "object",
        properties: { word: { type: "string", minLength: 1 } },
        required: ["word"],
        additionalProperties: false,
      },
    });
  });

  it("answers a call with the text and the details", async () => {
    expect(await sent(post("/demo_echo", '{"word":"hi"}'))).toEqual({
      status: 200,
      body: { text: "hi", details: { length: 2 } },
    });
  });

  it("refuses bad input with the lines MCP gives, before execute runs", async () => {
    const mcp = await callTool(info, tools, "demo_echo", { wrod: "hi" });
    const lines = mcp.content.flatMap((block) =>
      block.type === "text" ? block.text.split("\n") : [],
    );
    expect(await sent(post("/demo_echo", '{"wrod":"hi"}'))).toEqual({
      status: 400,
      body: { lines },
    });
  });

  it("reads an empty body as no arguments", async () => {
    const check = validateInput(echo, {});
    expect(check.ok).toBe(false);
    const lines = check.ok ? [] : check.lines;
    expect(await sent(post("/demo_echo", ""))).toEqual({ status: 400, body: { lines } });
  });

  it("turns away a body that isn't JSON", async () => {
    const { status, body } = await sent(post("/demo_echo", "{word"));
    expect(status).toBe(400);
    expect((body as { lines: string[] }).lines[0]).toMatch(/^Body is not JSON: /);
  });

  it("refuses a body without a JSON content type, so a page can't skip the preflight", async () => {
    written = [];
    const handlerForWrites = createHttpHandler(info, tools, { effects: ["write"] });
    const plain = await handlerForWrites.fetch(post("/demo_save", '{"word":"x"}', "text/plain"));
    const none = await handlerForWrites.fetch(
      new Request("http://localhost/demo_save", { method: "POST", body: '{"word":"x"}' }),
    );
    expect([plain.status, none.status]).toEqual([415, 415]);
    expect(written).toEqual([]);
    const typed = await handlerForWrites.fetch(
      post("/demo_save", '{"word":"x"}', "Application/JSON; charset=utf-8"),
    );
    expect(typed.status).toBe(200);
    expect(written).toEqual(["x"]);
  });

  it("keeps write tools behind effects", async () => {
    written = [];
    expect(await sent(post("/demo_save", '{"word":"x"}'))).toEqual({
      status: 403,
      body: { lines: ["demo_save is a write tool, and this handler serves read"] },
    });
    expect(written).toEqual([]);
    const both = createHttpHandler(info, tools, { effects: ["read", "write"] });
    const listing = (await (await both.fetch(new Request("http://localhost/"))).json()) as {
      tools: { name: string }[];
    };
    expect(listing.tools.map((tool) => tool.name)).toContain("demo_save");
    expect((await both.fetch(post("/demo_save", '{"word":"y"}'))).status).toBe(200);
    expect(written).toEqual(["y"]);
  });

  it.each(["demo_nope", "toString", "__proto__", "constructor"])(
    "answers 404 for the unknown tool %s",
    async (name) => {
      expect(await sent(post(`/${name}`, "{}"))).toEqual({
        status: 404,
        body: { lines: [`Unknown demo tool: "${name}"`] },
      });
    },
  );

  it.each(["/demo_echo/", "/demo_echo/more", "//demo_echo"])(
    "finds nothing at %s",
    async (path) => {
      const { status } = await sent(post(path, "{}"));
      expect(status).toBe(404);
    },
  );

  it("names the method each path takes", async () => {
    const get = await handler.fetch(new Request("http://localhost/demo_echo"));
    const postRoot = await handler.fetch(post("/", "{}"));
    expect([get.status, get.headers.get("allow")]).toEqual([405, "POST"]);
    expect([postRoot.status, postRoot.headers.get("allow")]).toEqual([405, "GET"]);
  });

  it("answers an error result with 422 and keeps its text and details", async () => {
    expect(await sent(post("/demo_sulk", ""))).toEqual({
      status: 422,
      body: { text: "no word today", details: { mood: "bad" } },
    });
  });

  it("answers a throw with 500, its cause lines and no forged line", async () => {
    expect(await sent(post("/demo_crash", ""))).toEqual({
      status: 500,
      body: { lines: ["demo_crash failed: upstream forged line", "caused by: socket hang up"] },
    });
  });

  it("answers 500 when the details aren't JSON, instead of throwing at the host", async () => {
    const { status, body } = await sent(post("/demo_huge", ""));
    expect(status).toBe(500);
    expect((body as { lines: string[] }).lines[0]).toMatch(/^demo_huge failed: .*BigInt/);
  });

  it("keeps details in the answer when the tool has none", async () => {
    expect(await sent(post("/demo_bare", ""))).toEqual({
      status: 200,
      body: { text: "bare", details: null },
    });
  });

  it("hands the images over beside the text", async () => {
    expect(await sent(post("/demo_pixel", ""))).toEqual({
      status: 200,
      body: {
        text: "one pixel",
        details: {},
        images: [{ data: "iVBORw0KGgo=", mimeType: "image/png" }],
      },
    });
  });

  it("gives the tool the request as host, and no progress or ask", async () => {
    const request = new Request("http://localhost/demo_peek", {
      method: "POST",
      headers: { "content-type": "application/json", "x-agent": "gtk" },
    });
    expect(await sent(request)).toEqual({ status: 200, body: { text: "gtk", details: {} } });
    expect(seen?.host).toEqual({ http: true, request });
    expect(seen?.progress).toBeUndefined();
    expect(seen?.ask).toBeUndefined();
  });

  it("cancels a read when the request is aborted", async () => {
    const controller = new AbortController();
    const request = new Request("http://localhost/demo_stall", {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: controller.signal,
    });
    const pending = handler.fetch(request);
    controller.abort(new Error("client left"));
    const response = await pending;
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ lines: ["demo_stall failed: client left"] });
  });

  it("sits under a base path", async () => {
    const mounted = createHttpHandler(info, tools, { base: "/http/demo/" });
    const listing = await mounted.fetch(new Request("http://localhost/http/demo"));
    const slash = await mounted.fetch(new Request("http://localhost/http/demo/"));
    const echoed = await mounted.fetch(post("/http/demo/demo_echo", '{"word":"up"}'));
    const beside = await mounted.fetch(post("/http/demox/demo_echo", '{"word":"up"}'));
    const root = await mounted.fetch(new Request("http://localhost/"));
    expect([listing.status, slash.status, echoed.status, beside.status, root.status]).toEqual([
      200, 200, 200, 404, 404,
    ]);
    expect(await echoed.json()).toEqual({ text: "up", details: { length: 2 } });
  });

  it.each([
    [["reed"], 'effects takes read, write, destructive, exec, got "reed"'],
    ["read", 'effects must be a list, got "read"'],
  ])("refuses effects %j instead of serving nothing", (effects, message) => {
    const options = { effects } as unknown as Parameters<typeof createHttpHandler>[2];
    expect(() => createHttpHandler(info, tools, options)).toThrow(new TypeError(message));
  });

  it("finds a base with characters the URL encodes", async () => {
    const mounted = createHttpHandler(info, tools, { base: "/outils/café" });
    const listing = await mounted.fetch(new Request("http://localhost/outils/café"));
    const echoed = await mounted.fetch(post("/outils/café/demo_echo", '{"word":"ok"}'));
    expect([listing.status, echoed.status]).toEqual([200, 200]);
  });

  it("refuses a body over the cap without waiting for it to end", async () => {
    const capped = createHttpHandler(info, tools, { maxRequestBodySize: 16 });
    const endless = new ReadableStream<Uint8Array>({});
    const init = {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": "1000000000" },
      body: endless,
      duplex: "half",
    };
    const response = await capped.fetch(new Request("http://localhost/demo_echo", init));
    expect([response.status, await response.json()]).toEqual([
      413,
      { lines: ["Body is over 16 bytes"] },
    ]);
  });

  it("counts a streamed body without a length against the cap", async () => {
    const capped = createHttpHandler(info, tools, { maxRequestBodySize: 16 });
    const streamed = (text: string): Request => {
      const bytes = new TextEncoder().encode(text);
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
          controller.close();
        },
      });
      const init = {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        duplex: "half",
      };
      return new Request("http://localhost/demo_echo", init);
    };
    const over = await capped.fetch(streamed('{"word":"seventeen"}'));
    const fits = await capped.fetch(streamed('{"word":"sixty"}'));
    expect([over.status, fits.status]).toEqual([413, 200]);
  });

  it("refuses an oversized body even when middleware holds a clone of the request", async () => {
    const capped = createHttpHandler(info, tools, { maxRequestBodySize: 4 });
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("0123456789"));
      },
    });
    const init = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      duplex: "half",
    };
    const request = new Request("http://localhost/demo_echo", init);
    const clone = request.clone();
    const response = await capped.fetch(request);
    expect(response.status).toBe(413);
    await clone.body?.cancel();
  });

  it.each([0, -1, Number.NaN, "4mb"])("refuses maxRequestBodySize %j", (size) => {
    const options = { maxRequestBodySize: size } as unknown as Parameters<
      typeof createHttpHandler
    >[2];
    expect(() => createHttpHandler(info, tools, options)).toThrow(RangeError);
  });

  it("refuses a base that isn't a path", () => {
    expect(() => createHttpHandler(info, tools, { base: "http/demo" })).toThrow(
      new TypeError('base must start with "/", got "http/demo"'),
    );
  });

  it("mounts in h3 as it is", async () => {
    const mounted = createHttpHandler(info, tools, { base: "/http/demo" });
    const app = new H3().all("/http/demo/**", async (event) => await mounted.fetch(event.req));
    const response = await app.fetch(post("/http/demo/demo_echo", '{"word":"h3"}'));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ text: "h3", details: { length: 2 } });
  });
});
