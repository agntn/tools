import { version } from "../../../package.json";

/** The Docus page tools as `tools`, with a pitch and an icon so the card is more than a name. */
export default defineMcpHandler({
  name: "tools",
  version,
  description:
    "The docs for @agntn/tools, one tool definition that MCP, Pi, OMP, the AI SDK and the command line all take. List the pages, read one, and stop writing the same schema five times.",
  icons: [
    { src: "https://tools.agntn.dev/favicon.svg", mimeType: "image/svg+xml", sizes: ["any"] },
    { src: "https://tools.agntn.dev/icon-512.png", mimeType: "image/png", sizes: ["512x512"] },
  ],
});
