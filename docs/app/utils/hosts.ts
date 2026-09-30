import { validateInput, type ToolDefinition } from "@agntn/tools";
import { registerOmpTools } from "@agntn/tools/omp";
import { registerPiTools } from "@agntn/tools/pi";

import rootPackage from "../../../package.json" with { type: "json" };
import { slugTool } from "./demo-tool";

export type HostKey = "mcp" | "pi" | "omp" | "ai";

/** The four hosts, in the order every panel walks them. */
export const HOSTS: readonly { key: HostKey; name: string; short: string; icon: string; adapter: string }[] = [
  { key: "mcp", name: "MCP server", short: "MCP", icon: "i-lucide-plug", adapter: "createMcpServer" },
  { key: "pi", name: "Pi extension", short: "Pi", icon: "i-lucide-pi", adapter: "registerPiTools" },
  { key: "omp", name: "OMP extension", short: "OMP", icon: "i-lucide-terminal", adapter: "registerOmpTools" },
  { key: "ai", name: "AI SDK tool", short: "AI SDK", icon: "i-lucide-sparkles", adapter: "toAiTool" },
];

/** Where each host's adapter lives, what it needs installed and how a tool reaches it. */
export const HOST_META: Record<
  HostKey,
  { to: string; entry: string; peer: string; schema: string; failure: string; blurb: string }
> = {
  mcp: {
    to: "/hosts/mcp",
    entry: "@agntn/tools/mcp",
    peer: "@modelcontextprotocol/server",
    schema: "inputSchema, verbatim",
    failure: "isError: true",
    blurb: "An MCP server on SDK v2, one list and one call handler for every tool",
  },
  pi: {
    to: "/hosts/pi",
    entry: "@agntn/tools/pi",
    peer: "@earendil-works/pi-coding-agent",
    schema: "parameters, same JSON Schema",
    failure: "thrown",
    blurb: "Pi's registerTool with the prompt snippet and guidelines filled in",
  },
  omp: {
    to: "/hosts/omp",
    entry: "@agntn/tools/omp",
    peer: "@oh-my-pi/pi-coding-agent",
    schema: "Type.Unsafe(json), host validated",
    failure: "isError, bad input thrown",
    blurb: "OMP's registerTool with approval, status lines and the TypeBox trap defused",
  },
  ai: {
    to: "/hosts/ai-sdk",
    entry: "@agntn/tools/ai",
    peer: "ai",
    schema: "jsonSchema() + the core validator",
    failure: "thrown, tool error",
    blurb: "An AI SDK tool whose output is the details plus the text",
  },
};

/**
 * The peer range the package declares for a host, straight from the root package.json.
 *
 * @param {HostKey} key - The host.
 * @returns {string} The range, such as `>=2.2.0 <3`.
 */
export function peerRange(key: HostKey): string {
  const peers = (rootPackage as { peerDependencies?: Record<string, string> }).peerDependencies ?? {};
  return peers[HOST_META[key].peer] ?? "not declared";
}

/** One host's answer to one call: what the model or the host ends up with, as text. */
export interface HostAnswer {
  /** `true` when the host sees a failure: `isError`, a thrown error or a refused input. */
  failed: boolean;
  /** How the failure travels: returned `isError`, thrown, or refused before `execute`. */
  channel: "result" | "isError" | "thrown" | "refused";
  text: string;
}

type Registered = Record<string, unknown> & { execute: (...args: unknown[]) => Promise<unknown> };

/**
 * Registers the tool on a Pi host double and hands back what Pi got.
 *
 * @param {ToolDefinition} tool - Tool to register.
 * @returns {Registered} The object passed to `pi.registerTool`.
 */
export function piRegistration(tool: ToolDefinition = slugTool): Registered {
  let captured: Registered | undefined;
  const pi = { registerTool: (definition: Registered) => (captured = definition) };
  registerPiTools(pi as unknown as Parameters<typeof registerPiTools>[0], [tool]);
  return captured!;
}

/**
 * Registers the tool on an OMP host double. `Type.Unsafe` keeps the document it gets, the way the
 * host's own build emits it verbatim, and validates with the core, the way the host's does.
 *
 * @param {ToolDefinition} tool - Tool to register.
 * @returns {Registered} The object passed to `pi.registerTool`.
 */
export function ompRegistration(tool: ToolDefinition = slugTool): Registered {
  let captured: Registered | undefined;
  const pi = {
    typebox: { Type: { Unsafe: (document: unknown) => ({ unsafe: document }) } },
    registerTool: (definition: Registered) => (captured = definition),
  };
  class Text {
    readonly text: string;
    constructor(text: string) {
      this.text = text;
    }
  }
  registerOmpTools(pi as unknown as Parameters<typeof registerOmpTools>[0], [tool], {
    Text: Text as unknown as Parameters<typeof registerOmpTools>[2]["Text"],
  });
  return captured!;
}

/**
 * The text of a failure the way a host shows it.
 *
 * @param {unknown} error - What was thrown.
 * @returns {string} The message.
 */
function thrown(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The text of a result's content blocks.
 *
 * @param {unknown} result - A tool result.
 * @returns {string} Its text blocks joined.
 */
function contentText(result: unknown): string {
  const content = (result as { content?: { type: string; text?: string }[] }).content ?? [];
  return content.map((block) => block.text ?? "").join("\n");
}

/** Sends one call to a real MCP server built by the adapter, through a real client, in memory. */
async function callMcp(tool: ToolDefinition, args: unknown): Promise<HostAnswer> {
  const [{ createMcpServer }, { Client, InMemoryTransport }] = await Promise.all([
    import("@agntn/tools/mcp"),
    import("@modelcontextprotocol/client"),
  ]);
  const server = createMcpServer({ name: "tools-docs", version: "0.0.0" }, [tool]);
  const client = new Client({ name: "tools-docs", version: "0.0.0" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  try {
    const result = await client.callTool({ name: tool.name, arguments: args as Record<string, unknown> });
    const failed = result.isError === true;
    return { failed, channel: failed ? "isError" : "result", text: contentText(result) };
  } finally {
    await Promise.all([client.close(), server.close()]);
  }
}

/** Calls the tool the way Pi does: through the registered `execute`, which throws on a failure. */
async function callPi(tool: ToolDefinition, args: unknown): Promise<HostAnswer> {
  try {
    const result = await piRegistration(tool).execute("call-1", args, undefined, undefined, {});
    return { failed: false, channel: "result", text: contentText(result) };
  } catch (error) {
    return { failed: true, channel: "thrown", text: thrown(error) };
  }
}

/** Calls the tool the way OMP does: a returned `isError` stays a result, a bad input throws. */
async function callOmp(tool: ToolDefinition, args: unknown): Promise<HostAnswer> {
  try {
    const result = (await ompRegistration(tool).execute("call-1", args, undefined, undefined, {})) as {
      isError?: boolean;
    };
    const failed = result.isError === true;
    return { failed, channel: failed ? "isError" : "result", text: contentText(result) };
  } catch (error) {
    return { failed: true, channel: "thrown", text: thrown(error) };
  }
}

/** Calls the tool the way the AI SDK does: the input schema first, then `execute`. */
async function callAi(tool: ToolDefinition, args: unknown): Promise<HostAnswer> {
  const [{ toAiTool }, { asSchema }] = await Promise.all([import("@agntn/tools/ai"), import("ai")]);
  const aiTool = toAiTool(tool);
  const checked = await asSchema(aiTool.inputSchema).validate?.(args);
  if (checked && !checked.success) {
    return { failed: true, channel: "refused", text: thrown(checked.error) };
  }
  try {
    const output = await aiTool.execute!(args as never, { toolCallId: "call-1", messages: [], context: {} } as never);
    return { failed: false, channel: "result", text: JSON.stringify(output) };
  } catch (error) {
    return { failed: true, channel: "thrown", text: thrown(error) };
  }
}

const CALLERS: Record<HostKey, (tool: ToolDefinition, args: unknown) => Promise<HostAnswer>> = {
  mcp: callMcp,
  pi: callPi,
  omp: callOmp,
  ai: callAi,
};

/**
 * Sends the same arguments to all four hosts.
 *
 * @param {unknown} args - Tool arguments, as a host would receive them.
 * @param {ToolDefinition} tool - Tool to call.
 * @returns {Promise<Record<HostKey, HostAnswer>>} Each host's answer.
 */
export async function callEveryHost(
  args: unknown,
  tool: ToolDefinition = slugTool,
): Promise<Record<HostKey, HostAnswer>> {
  const answers = await Promise.all(HOSTS.map(({ key }) => CALLERS[key](tool, args)));
  return Object.fromEntries(HOSTS.map(({ key }, index) => [key, answers[index]!])) as Record<
    HostKey,
    HostAnswer
  >;
}

/** The same idea, named differently by every host: the rows of the landing's dialect map. */
export const CONCEPTS = [
  { key: "name", candidates: ["name"] },
  { key: "label", candidates: ["title", "label"] },
  { key: "schema", candidates: ["inputSchema", "parameters"] },
  { key: "effect", candidates: ["annotations", "approval"] },
  { key: "prompt", candidates: ["promptSnippet"] },
  { key: "run", candidates: ["execute"] },
] as const;

export type Concept = (typeof CONCEPTS)[number]["key"];

/**
 * The field a registration uses for each concept, read off its own keys, or `null` when it has none.
 *
 * @param {object} registration - What the host received.
 * @returns {Record<Concept, string | null>} Field name per concept.
 */
function fieldsOf(registration: object): Record<Concept, string | null> {
  return Object.fromEntries(
    CONCEPTS.map((concept) => [
      concept.key,
      concept.candidates.find((field) => Object.hasOwn(registration, field)) ?? null,
    ]),
  ) as Record<Concept, string | null>;
}

/** What each host receives when the tool registers, as plain data a page can print. */
export interface HostView {
  key: HostKey;
  rows: { label: string; value: string; accent?: boolean }[];
  /** The field this host uses for each concept, from the registration itself. */
  fields: Record<Concept, string | null>;
  /** The registration the host gets, functions named instead of printed. */
  registration: string;
}

/**
 * Prints a registration object with its functions as `[function]`.
 *
 * @param {object} value - The object a host received.
 * @returns {string} Indented JSON.
 */
function printRegistration(value: object): string {
  return JSON.stringify(value, (_key, field: unknown) => (typeof field === "function" ? "[function]" : field), 2);
}

/**
 * Builds the four host views from the adapters themselves.
 *
 * @param {ToolDefinition} tool - Tool to register.
 * @returns {Promise<HostView[]>} One view per host, in `HOSTS` order.
 */
export async function hostViews(tool: ToolDefinition = slugTool): Promise<HostView[]> {
  const [{ Client, InMemoryTransport }, { createMcpServer, toolAnnotations }, { toAiTool }, { asSchema }] =
    await Promise.all([
      import("@modelcontextprotocol/client"),
      import("@agntn/tools/mcp"),
      import("@agntn/tools/ai"),
      import("ai"),
    ]);
  const server = createMcpServer({ name: "tools-docs", version: "0.0.0" }, [tool]);
  const client = new Client({ name: "tools-docs", version: "0.0.0" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  const listed = (await client.listTools()).tools[0]!;
  await Promise.all([client.close(), server.close()]);

  const keys = Object.keys(tool.input.properties).join(", ");
  const hints = Object.entries(toolAnnotations(tool))
    .filter(([, on]) => on === true)
    .map(([hint]) => hint.replace(/Hint$/u, ""))
    .join(", ");
  const pi = piRegistration(tool);
  const omp = ompRegistration(tool);
  const ai = toAiTool(tool);
  const aiSchema = (await asSchema(ai.inputSchema).jsonSchema) as { properties?: object };

  return [
    {
      key: "mcp",
      rows: [
        { label: "title", value: String(listed.title) },
        { label: "hints", value: hints, accent: true },
        { label: "inputSchema", value: keys },
        { label: "failure", value: "isError: true" },
      ],
      registration: printRegistration(listed),
      fields: fieldsOf(listed),
    },
    {
      key: "pi",
      rows: [
        { label: "label", value: String(pi.label) },
        {
          label: "prompt",
          value: ((count: number) => `snippet, ${count} rule${count === 1 ? "" : "s"}`)(
            (pi.promptGuidelines as unknown[] | undefined)?.length ?? 0,
          ),
          accent: true,
        },
        { label: "parameters", value: keys },
        { label: "failure", value: "thrown" },
      ],
      registration: printRegistration(pi),
      fields: fieldsOf(pi),
    },
    {
      key: "omp",
      rows: [
        { label: "label", value: String(omp.label) },
        { label: "approval", value: String(omp.approval), accent: true },
        { label: "parameters", value: "Type.Unsafe(json)" },
        { label: "failure", value: "isError or thrown" },
      ],
      registration: printRegistration(omp),
      fields: fieldsOf(omp),
    },
    {
      key: "ai",
      rows: [
        { label: "title", value: String(ai.title) },
        { label: "inputSchema", value: "jsonSchema()", accent: true },
        { label: "output", value: "details + text" },
        { label: "failure", value: "thrown" },
      ],
      registration: printRegistration({ ...ai, inputSchema: aiSchema }),
      fields: fieldsOf(ai),
    },
  ];
}

/**
 * The problems the core finds in a set of arguments, one per line, or none.
 *
 * @param {unknown} args - Tool arguments.
 * @param {ToolDefinition} tool - Tool whose schema applies.
 * @returns {readonly string[]} The failure lines.
 */
export function problems(args: unknown, tool: ToolDefinition = slugTool): readonly string[] {
  const checked = validateInput(tool, args);
  return checked.ok ? [] : checked.lines;
}
