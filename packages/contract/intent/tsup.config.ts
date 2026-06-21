import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["cjs", "esm"],
  dts: true,
  clean: true,
  // Keep the IR packages external so the re-exported IntentSummary types
  // reference @suss/ir-core's recursive TypeShape by name rather than
  // inlining the recursion into this package's .d.ts.
  external: ["@suss/intent-ir", "@suss/ir-core", "yaml", "zod"],
});
