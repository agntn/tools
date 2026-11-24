import { version } from "../../package.json";

/** One pitch and one icon pair, for `initialize` on `/mcp` and for the discovery card. */
export const serverInfo = {
  name: "tools",
  version,
  description:
    "The docs for @agntn/tools, one tool definition that MCP, Pi, OMP, the AI SDK and the command line all take. List the pages, read one, and stop writing the same schema five times.",
  /** Absolute URLs, so the card loses its icon without a word once either file leaves public/. */
  icons: [
    { src: "https://tools.agntn.dev/favicon.svg", mimeType: "image/svg+xml", sizes: ["any"] },
    { src: "https://tools.agntn.dev/icon-512.png", mimeType: "image/png", sizes: ["512x512"] },
  ],
};
