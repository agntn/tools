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
} from "./index.ts";

/**
 * What an AI SDK tool returns: the executor's details with the text MCP
 * clients read. Your code gets the whole object, the model reads only `text`.
 */
export type AiToolOutput<Details> = (Details extends object ? Details : { details: Details }) & {
  text: string;
};

/**
 * Converts one tool, keeping its input and details types.
 *
 * A result with `isError` throws its text, which the AI SDK reports to the
 * model as a tool error, the same as an executor that throws. The model reads
 * `text` alone, as on every other host, not the details spelled out a second time.
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
      const { details } = result;
      if (typeof details !== "object" || details === null) return { details, text };
      if (Object.hasOwn(details, "text")) {
        // The spread would overwrite one of the two without a sign.
        throw new ToolDefinitionError(
          `${definition.name}: details must not have a text field, the AI SDK output adds one`,
        );
      }
      return { ...details, text };
    },
    toModelOutput: ({ output }) => modelOutput(output),
  });
  return built as unknown as Tool<Static<Input>, AiToolOutput<Details>>;
}

/** What `toModelOutput` hands the model. */
type ModelOutput = { type: "text"; value: string } | { type: "json"; value: JSONValue };

/**
 * What the model reads: the text, or the whole output as JSON when there is none, as for an image.
 *
 * @param output - What `execute` returned, or what a client sent back as its output.
 * @returns {ModelOutput} The text, or the output as it is.
 */
function modelOutput(output: unknown): ModelOutput {
  const text =
    typeof output === "object" && output !== null ? (output as { text?: unknown }).text : undefined;
  return typeof text === "string" && text !== ""
    ? { type: "text", value: text }
    : { type: "json", value: output as JSONValue };
}

/**
 * Builds an AI SDK tool set keyed by tool name.
 *
 * @param tools - Tools to convert.
 * @returns {Record<string, Tool>} AI SDK tools.
 * @throws {ToolDefinitionError} When two tools share a name.
 */
export function toAiTools(tools: readonly ToolDefinition[]): Record<string, Tool> {
  indexTools(tools);
  return Object.fromEntries(tools.map((definition) => [definition.name, toAiTool(definition)]));
}
