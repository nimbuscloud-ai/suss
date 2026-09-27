import { defineConfig } from "tsup";

export default defineConfig([
  // Library entries: pure exports, no shebang. Importing these from a host
  // package must be side-effect free. The heap entry stays apart so another
  // executable can size its heap before loading the rest of the CLI.
  {
    entry: ["src/index.ts", "src/heapSize.ts"],
    format: ["esm"],
    dts: true,
    clean: true,
  },
  // Bin entry: the only file that runs runCli + process.exit. Carries
  // the shebang so the published `suss` binary is executable.
  {
    entry: ["src/bin.ts"],
    format: ["esm"],
    dts: false,
    clean: false,
    banner: { js: "#!/usr/bin/env node" },
  },
]);
