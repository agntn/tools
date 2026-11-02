import { globSync, readdirSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vite-plus/test";

const DOCS = new URL("../docs/", import.meta.url);
const CONTENT = new URL("content/", DOCS);

/** Statements start a line, so a snippet quoting `from "ai"` in a string never counts. */
const SPECIFIER =
  /^\s*(?:import|export|\})\b[^"'\n]*?\bfrom\s*["']([@a-z][^"'\s]*)["']|^\s*import\s*["']([@a-z][^"'\s]*)["']|\bimport\s*\(\s*["']([@a-z][^"'\s]*)["']/gmu;

/* Every package the site's own files import, without `node:` and the `@agntn/tools` alias. */
function siteImports(): Set<string> {
  const files = globSync(["app/**/*.{ts,vue}", "server/**/*.ts", "*.ts"], { cwd: DOCS });
  const names = new Set<string>();
  for (const file of files) {
    for (const match of readFileSync(new URL(file, DOCS), "utf8").matchAll(SPECIFIER)) {
      const specifier = match[1] ?? match[2] ?? match[3] ?? "";
      const name = specifier.split("/", specifier.startsWith("@") ? 2 : 1).join("/");
      if (!name.startsWith("node:") && name !== "@agntn/tools") names.add(name);
    }
  }
  return names;
}

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

describe("docs dependencies", () => {
  it("declares every package the site imports, since nothing hoists them anymore", () => {
    const manifest = JSON.parse(readFileSync(new URL("package.json", DOCS), "utf8")) as {
      readonly dependencies: Readonly<Record<string, string>>;
      readonly devDependencies: Readonly<Record<string, string>>;
    };
    const declared = new Set([
      ...Object.keys(manifest.dependencies),
      ...Object.keys(manifest.devDependencies),
    ]);
    const imported = siteImports();
    expect(imported).toContain("docus");
    expect([...imported].filter((name) => !declared.has(name))).toEqual([]);
  });
});
