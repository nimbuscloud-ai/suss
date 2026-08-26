import { defineConfig } from "tsup";

export default defineConfig([
  // Library entry: the server, built but not started, so a host can
  // mount it on its own transport. ESM only, since @suss/cli is.
  {
    entry: ["src/index.ts"],
    format: ["esm"],
    dts: true,
    clean: true,
    external: [
      "@modelcontextprotocol/sdk",
      "@suss/behavioral-ir",
      "@suss/cli",
      "zod",
    ],
  },
  // Bin entry: the only file that opens stdio and runs. Carries the
  // shebang so the published binary is executable.
  {
    entry: ["src/bin.ts"],
    format: ["esm"],
    dts: false,
    clean: false,
    banner: { js: "#!/usr/bin/env node" },
    external: [
      "@modelcontextprotocol/sdk",
      "@suss/behavioral-ir",
      "@suss/cli",
      "zod",
    ],
  },
]);
