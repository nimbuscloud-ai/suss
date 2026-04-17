import { defineConfig } from "tsup";

export default defineConfig([
  // Library entry — pure exports, no shebang. Importing this from a host
  // package must be side-effect free.
  {
    entry: ["src/index.ts"],
    format: ["esm"],
    dts: true,
    clean: true,
  },
  // Bin entry — the only file that runs runCli + process.exit. Carries
  // the shebang so the published `suss` binary is executable.
  {
    entry: ["src/bin.ts"],
    format: ["esm"],
    dts: false,
    clean: false,
    banner: { js: "#!/usr/bin/env node" },
  },
]);
