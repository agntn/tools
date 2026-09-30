import { resolve } from "node:path";
import { toolsTheme } from "./shiki-theme";

/** Bundled from the checkout's sources: a deploy needs neither dist/ nor the root node_modules. */
const librarySource = resolve(import.meta.dirname, "../src");

/** The npm packages the library's core and adapters import; each is a dependency here too. */
const LIBRARY_DEPENDENCIES = [
  "typebox",
  "@modelcontextprotocol/server",
  "@modelcontextprotocol/client",
  "ai",
];

export default defineNuxtConfig({
  extends: ["docus"],
  /** The repo root is its own pnpm workspace; Nuxt must not treat it as this site's. */
  workspaceDir: import.meta.dirname,
  alias: {
    "@agntn/tools/mcp": resolve(librarySource, "mcp.ts"),
    "@agntn/tools/pi": resolve(librarySource, "pi.ts"),
    "@agntn/tools/omp": resolve(librarySource, "omp.ts"),
    "@agntn/tools/ai": resolve(librarySource, "ai.ts"),
    "@agntn/tools": resolve(librarySource, "index.ts"),
  },
  vite: {
    build: { target: "es2024" },
    /** `../src` resolves bare imports from the repo root upward, never from docs/node_modules, unless deduped. */
    resolve: { dedupe: LIBRARY_DEPENDENCIES },
    optimizeDeps: {
      include: [
        "typebox/type",
        "typebox/value",
        "@modelcontextprotocol/server",
        "@modelcontextprotocol/client",
        "ai",
      ],
    },
    server: {
      /** Dev serves the library from outside the workspace, which Vite refuses without this. */
      fs: { allow: [librarySource] },
    },
  },
  devtools: { enabled: false },
  telemetry: false,
  site: {
    url: "https://tools.agntn.dev",
    name: "@agntn/tools",
  },
  llms: {
    domain: "https://tools.agntn.dev",
    title: "@agntn/tools",
    description:
      "One tool definition served to MCP, Pi, OMP and the AI SDK. TypeBox schema, validation on every surface, errors that stay on one line.",
    sections: [
      {
        title: "Playground",
        description: "One call sent to all four hosts at once, in the browser.",
        links: [
          {
            title: "Playground",
            href: "https://tools.agntn.dev/playground",
            description:
              "A real MCP server, the Pi and OMP adapters and the AI SDK tool, all running in the page.",
          },
        ],
      },
    ],
  },
  /** Docus pages define their own OG images; the alt text is the one thing they leave unset. */
  ogImage: {
    defaults: {
      alt: "@agntn/tools: one tool definition for MCP, Pi, OMP and the AI SDK",
    },
  },
  icon: {
    clientBundle: {
      icons: [
        "lucide:arrow-down",
        "lucide:arrow-left",
        "lucide:arrow-right",
        "lucide:arrow-up",
        "lucide:arrow-up-right",
        "lucide:book-open",
        "lucide:bot",
        "lucide:brackets",
        "lucide:check",
        "lucide:chevron-down",
        "lucide:chevron-left",
        "lucide:chevron-right",
        "lucide:chevrons-up-down",
        "lucide:circle-alert",
        "lucide:circle-check",
        "lucide:circle-x",
        "lucide:copy",
        "lucide:external-link",
        "lucide:flask-conical",
        "lucide:info",
        "lucide:layers",
        "lucide:link",
        "lucide:list-ordered",
        "lucide:pi",
        "lucide:plug",
        "lucide:rotate-ccw",
        "lucide:shield-check",
        "lucide:sparkles",
        "lucide:table",
        "lucide:terminal",
        "lucide:triangle-alert",
        "lucide:wrench",
        "lucide:x",
        "simple-icons:github",
        "simple-icons:npm",
        "vscode-icons:file-type-js",
        "vscode-icons:file-type-json",
        "vscode-icons:file-type-shell",
        "vscode-icons:file-type-typescript",
      ],
    },
  },
  colorMode: {
    preference: "dark",
  },
  app: {
    head: {
      link: [
        { rel: "icon", type: "image/svg+xml", href: "/favicon.svg" },
        { rel: "apple-touch-icon", sizes: "180x180", href: "/apple-touch-icon.png" },
        { rel: "manifest", href: "/site.webmanifest" },
      ],
      meta: [
        { name: "theme-color", media: "(prefers-color-scheme: dark)", content: "#0b0d10" },
        { name: "theme-color", media: "(prefers-color-scheme: light)", content: "#eef1f4" },
        { name: "apple-mobile-web-app-title", content: "tools" },
        { name: "author", content: "oritwoen" },
        { property: "og:locale", content: "en_US" },
      ],
    },
  },
  /** Docus ships an MCP endpoint that wants the Cloudflare Agents SDK on Workers. Not needed. */
  mcp: {
    enabled: false,
  },
  nitro: {
    preset: "cloudflare_module",
    compatibilityDate: "2026-09-03",
    esbuild: { options: { target: "es2024" } },
    prerender: {
      crawlLinks: true,
      routes: ["/", "/playground", "/sitemap.xml", "/robots.txt", "/llms.txt", "/llms-full.txt"],
    },
    cloudflare: {
      deployConfig: true,
      nodeCompat: true,
    },
  },
  compatibilityDate: "2026-09-03",
  /** Fonts live in public/fonts and app/assets/fonts.css, where nuxt-og-image reads them from. */
  css: ["~/assets/fonts.css"],
  fonts: {
    families: [
      { name: "Figtree", provider: "local", weights: [400, 500] },
      { name: "Fira Code", provider: "local", weights: [400, 500] },
    ],
  },
  content: {
    database: {
      type: "d1",
      bindingName: "DB",
    },
    build: {
      markdown: {
        highlight: {
          theme: {
            default: toolsTheme,
            light: toolsTheme,
            dark: toolsTheme,
          },
        },
      },
    },
  },
});
