import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["cjs", "esm"],
  dts: true,
  clean: true,
  // SyntaxKind comes from typescript through ts-morph, so bundling it
  // pulls the compiler in and the result reaches `fs` through a require
  // an ESM bundle cannot answer. Every consumer already has ts-morph.
  external: ["ts-morph"],
});
