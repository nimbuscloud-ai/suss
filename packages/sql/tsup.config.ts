import { defineConfig } from "tsup";

// The SQL parser is bundled rather than depended on. Its published
// package is 92MB of browser builds, source maps, and dialects nobody
// here reads, and the four dialect builds this uses come to about 1MB
// once bundled, so a project installing suss downloads that instead.
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["cjs", "esm"],
  dts: true,
  clean: true,
  noExternal: ["node-sql-parser"],
});
