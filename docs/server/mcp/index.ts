import { version } from "../../../package.json";

/** The Docus page tools, served as `tools` under the package's own version. */
export default defineMcpHandler({ name: "tools", version });
