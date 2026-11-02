import { readdirSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vite-plus/test";

const CONTENT = new URL("../docs/content/", import.meta.url);

/* The frontmatter description of every docs page that has one. */
const descriptions = readdirSync(CONTENT, { recursive: true, encoding: "utf8" })
  .filter((page) => page.endsWith(".md"))
  .map((page) => {
    const frontmatter = readFileSync(new URL(page, CONTENT), "utf8").split("---")[1] ?? "";
    return [page, /^description: (.*)$/m.exec(frontmatter)?.[1]] as const;
  })
  .filter((entry): entry is readonly [string, string] => entry[1] !== undefined);

describe("docs pages", () => {
  it("has descriptions to check", () => {
    expect(descriptions.length).toBeGreaterThan(5);
  });

  /**
   * Docus up to 5.14 puts the description in the OG image's file name, where a comma splits it and
   * `..png` is skipped, and a bare `: ` turns the YAML into a mapping that drops the page.
   */
  it.each(descriptions)("keeps the description of %s to plain sentences", (_page, description) => {
    expect(description).not.toMatch(/,|\.$|: /);
  });
});
