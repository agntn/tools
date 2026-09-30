import { defineTool, Type } from "@agntn/tools";

/** Separators `text_slug` accepts, in the order the schema lists them. */
export const SEPARATORS = ["-", "_", "."] as const;

/** What `text_slug` hands back besides the text: the slug and how many words went into it. */
export interface SlugDetails {
  slug: string;
  words: number;
}

/**
 * Turns a title into a URL slug. Every panel on this site registers this one tool with every host
 * and calls it, so what you see is what the adapters really do.
 */
export const slugTool = defineTool({
  name: "text_slug",
  title: "Text Slug",
  description: "Turn a title into a lowercase URL slug. Letters and digits stay, accents lose their marks, the rest becomes the separator.",
  snippet: "Use text_slug to turn a title into a URL slug.",
  guidelines: ["Pass separator '_' for identifiers. The default '-' is for URLs."],
  effect: "read",
  input: Type.Object({
    text: Type.String({ minLength: 1, maxLength: 200, pattern: "\\S", description: "Title to slug" }),
    separator: Type.Optional(Type.Enum(SEPARATORS, { description: "Joins the words. '-' when omitted" })),
  }, { additionalProperties: false }),
  execute({ text, separator = "-" }) {
    const words =
      text
        .normalize("NFKD")
        .replaceAll(/\p{M}/gu, "")
        .toLowerCase()
        .match(/[a-z0-9]+/g) ?? [];
    if (words.length === 0) {
      return {
        content: [{ type: "text", text: `Nothing to slug in ${JSON.stringify(text)}: no letters or digits.` }],
        details: { slug: "", words: 0 },
        isError: true,
      };
    }
    const slug = words.join(separator);
    return { content: [{ type: "text", text: slug }], details: { slug, words: words.length } };
  },
});
