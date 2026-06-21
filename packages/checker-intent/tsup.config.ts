import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["cjs", "esm"],
  dts: true,
  clean: true,
  // Keep workspace + zod external so re-exported IntentFinding types
  // reference @suss/ir-core's recursive TypeShape by name.
  external: ["@suss/behavioral-ir", "@suss/intent-ir", "@suss/ir-core", "zod"],
});
