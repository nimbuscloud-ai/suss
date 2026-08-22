import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/ast.ts"],
  format: ["cjs", "esm"],
  dts: true,
  clean: true,
});
