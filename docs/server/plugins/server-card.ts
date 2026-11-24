import { serverCardHook } from "@agntn/tools/toolkit";
import { serverInfo } from "../server-info";

/** Without this the card says `@agntn/tools` and nothing else, while `initialize` has the pitch. */
export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook("agent-discovery:mcp-server-card", serverCardHook(serverInfo, []));
});
