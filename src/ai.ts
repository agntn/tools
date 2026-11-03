/**
 * AI SDK adapter: turns {@link ToolDefinition}s into AI SDK tools.
 *
 * The TypeBox schema goes through `jsonSchema()` with the shared validator, so
 * a package needs no second schema in Zod.
 */

import { jsonSchema, tool, type JSONValue, type Tool } from "ai";
import type { Static, TObject } from "typebox";

import {
  indexTools,
  invokeTool,
  resultText,
  ToolDefinitionError,
  validateInput,
  wireSchema,
  type ToolDefinition,
  type ToolResult,
} from "./index.ts";

/** An image block of the result, base64 with its MIME type, as MCP sends it. */
export interface AiToolImage {
  data: string;
  mimeType: string;
}

/**
 * What an AI SDK tool returns: the executor's details with the text MCP
 * clients read. Your code gets the whole object, the model reads `text` and `images`.
 */
export type AiToolOutput<Details> = (Details extends object ? Details : { details: Details }) & {
  text: string;
  /** The result's image blocks, present only when it has some. */
  images?: AiToolImage[];
};

/**
 * Converts one tool, keeping its input and details types.
 *
 * A result with `isError` throws its text, which the AI SDK reports to the
 * model as a tool error, the same as an executor that throws. The model reads
 * `text` and the images, as on every other host, not the details spelled out a second time.
 *
 * @param definition - Tool to convert.
 * @returns {Tool} AI SDK tool.
 */
export function toAiTool<Input extends TObject, Details>(
  definition: ToolDefinition<Input, Details>,
): Tool<Static<Input>, AiToolOutput<Details>> {
  // Built on concrete types and narrowed once on return: the AI SDK's
  // `NeverOptional` does not resolve for a generic output type.
  const built = tool({
    title: definition.title,
    description: definition.description,
    inputSchema: jsonSchema<unknown>(wireSchema(definition), {
      validate(value) {
        const checked = validateInput(definition, value);
        return checked.ok
          ? { success: true, value: checked.value }
          : { success: false, error: new Error(checked.lines.join("\n")) };
      },
    }),
    async execute(input, { abortSignal }): Promise<object> {
      const result = await invokeTool(
        definition,
        input,
        abortSignal ? { signal: abortSignal } : {},
      );
      const text = resultText(result);
      if (result.isError) throw new Error(text);
      return aiOutput(definition.name, result, text);
    },
    toModelOutput: ({ output }) => modelOutput(output),
  });
  return built as unknown as Tool<Static<Input>, AiToolOutput<Details>>;
}

/** Fields the adapter adds to the details, which the spread would silently overwrite. */
const ADDED_FIELDS = ["text", "images"] as const;

/**
 * Builds what `execute` returns: the details with the text, and the images when there are any.
 *
 * @param name - Tool name, for the error.
 * @param result - Result of a call that did not fail.
 * @param text - Its text blocks, joined.
 * @returns {object} The {@link AiToolOutput} of the call.
 * @throws {ToolDefinitionError} When the details already have `text` or `images`.
 */
function aiOutput(name: string, result: ToolResult, text: string): object {
  const images = result.content.flatMap((block) =>
    block.type === "image" ? [{ data: block.data, mimeType: block.mimeType }] : [],
  );
  const added = images.length > 0 ? { text, images } : { text };
  const { details } = result;
  if (typeof details !== "object" || details === null) return { details, ...added };
  const taken = ADDED_FIELDS.find((field) => Object.hasOwn(details, field));
  if (taken !== undefined) {
    throw new ToolDefinitionError(
      `${name}: details must not have their own ${taken} field, the AI SDK output adds one`,
    );
  }
  return { ...details, ...added };
}

/** A part of a `content` answer: the text, or one image as file data. */
type ModelPart =
  | { type: "text"; text: string }
  | { type: "file"; data: { type: "data"; data: string }; mediaType: string };

/** What `toModelOutput` hands the model. */
type ModelOutput =
  | { type: "text"; value: string }
  | { type: "json"; value: JSONValue }
  | { type: "content"; value: ModelPart[] };

/**
 * What the model reads: the text with the images, or the whole output as JSON when it has neither.
 *
 * @param output - What `execute` returned, or what a client sent back as its output.
 * @returns {ModelOutput} The text and images, or the output as it is.
 */
function modelOutput(output: unknown): ModelOutput {
  const { text, images } = outputFields(output);
  if (images.length > 0) {
    const files = images.map((image): ModelPart => ({
      type: "file",
      data: { type: "data", data: image.data },
      mediaType: image.mimeType,
    }));
    return { type: "content", value: text === "" ? files : [{ type: "text", text }, ...files] };
  }
  return text === "" ? { type: "json", value: output as JSONValue } : { type: "text", value: text };
}

/**
 * Reads `text` and `images` off an output a stored chat may have mangled, dropping what isn't one.
 *
 * @param output - What `execute` returned, or what a client sent back as its output.
 * @returns {{ text: string; images: AiToolImage[] }} The text, or "", and the valid images.
 */
function outputFields(output: unknown): { text: string; images: AiToolImage[] } {
  if (typeof output !== "object" || output === null) return { text: "", images: [] };
  const { text, images } = output as { text?: unknown; images?: unknown };
  return {
    text: typeof text === "string" ? text : "",
    images: Array.isArray(images) ? images.filter(isImage) : [],
  };
}

/**
 * Tells an {@link AiToolImage} from anything else in a stored output.
 *
 * @param value - One entry of `images`.
 * @returns {boolean} Whether it has string `data` and `mimeType`.
 */
function isImage(value: unknown): value is AiToolImage {
  if (typeof value !== "object" || value === null) return false;
  const { data, mimeType } = value as { data?: unknown; mimeType?: unknown };
  return typeof data === "string" && typeof mimeType === "string";
}

/** What {@link toAiTools} returns: each tool under its own name, typed like {@link toAiTool}. */
export type AiTools<Tools extends readonly ToolDefinition[]> = {
  [Definition in Tools[number] as Definition["name"]]: Definition extends ToolDefinition<
    infer Input,
    infer Details
  >
    ? Tool<Static<Input>, AiToolOutput<Details>>
    : never;
};

/**
 * Builds an AI SDK tool set keyed by tool name, typed per tool.
 * `Object.fromEntries` only knows a record, so the result is cast to the `AiTools` it built.
 *
 * @param tools - Tools to convert.
 * @returns {AiTools<Tools>} AI SDK tools.
 * @throws {ToolDefinitionError} When two tools share a name.
 */
export function toAiTools<const Tools extends readonly ToolDefinition[]>(
  tools: Tools,
): AiTools<Tools> {
  indexTools(tools);
  return Object.fromEntries(
    tools.map((definition) => [definition.name, toAiTool(definition)]),
  ) as AiTools<Tools>;
}
