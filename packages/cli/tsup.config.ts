import { readFile } from "node:fs/promises";
import path from "node:path";

import { defineConfig } from "tsup";

import type { Plugin } from "esbuild";

// `import text from "./file?raw"` gives the file's text, so the map can
// put its stylesheet and script inside the page. Vitest reads `?raw` on
// its own; this does the same for the build.
const RAW = "?raw";
const rawText: Plugin = {
  name: "raw-text",
  setup(build) {
    // The path keeps `?raw` until it is read, or tsup's own stylesheet
    // handling takes a `.css` file first.
    build.onResolve({ filter: /\?raw$/ }, (args) => ({
      path: path.resolve(args.resolveDir, args.path),
      namespace: "raw-text",
    }));
    build.onLoad({ filter: /\?raw$/, namespace: "raw-text" }, async (args) => ({
      contents: await readFile(args.path.slice(0, -RAW.length), "utf8"),
      loader: "text",
    }));
  },
};

export default defineConfig([
  // Library entries: pure exports, no shebang. Importing these from a host
  // package must be side-effect free. The heap entry stays apart so another
  // executable can size its heap before loading the rest of the CLI.
  {
    entry: ["src/index.ts", "src/heapSize.ts"],
    format: ["esm"],
    dts: true,
    clean: true,
    esbuildPlugins: [rawText],
  },
  // Bin entry: the only file that runs runCli + process.exit. Carries
  // the shebang so the published `suss` binary is executable.
  {
    entry: ["src/bin.ts"],
    format: ["esm"],
    dts: false,
    clean: false,
    banner: { js: "#!/usr/bin/env node" },
    esbuildPlugins: [rawText],
  },
]);
