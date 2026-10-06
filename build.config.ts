import { defineBuildConfig } from "obuild/config";

export default defineBuildConfig({
  entries: [
    {
      type: "bundle",
      input: [
        "./src/index.ts",
        "./src/mcp.ts",
        "./src/h3.ts",
        "./src/pi.ts",
        "./src/omp.ts",
        "./src/ai.ts",
        "./src/cli.ts",
      ],
    },
  ],
});
