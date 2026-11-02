import { defineBuildConfig } from "obuild/config";

/**
 * TypeBox stays a devDependency so it lands in the bundle: OMP's loader walks every module it
 * imports, and its 688 cost 200 ms per start against 20 ms for one chunk.
 */
export default defineBuildConfig({
  entries: [
    {
      type: "bundle",
      input: [
        "./src/index.ts",
        "./src/mcp.ts",
        "./src/h3.ts",
        "./src/toolkit.ts",
        "./src/pi.ts",
        "./src/omp.ts",
        "./src/ai.ts",
        "./src/cli.ts",
      ],
      /** No maps: obuild strips comments after mapping, so every map pointed at the wrong line. */
      dts: { sourcemap: false },
    },
  ],
});
