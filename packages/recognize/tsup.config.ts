import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/ast.ts", "src/factOps.ts"],
  format: ["cjs", "esm"],
  dts: true,
  clean: true,
});
