import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["cjs", "esm"],
  dts: true,
  clean: true,
  // parser.ts resolves the grammar asset's path from `import.meta.url`
  // to locate `grammar/tree-sitter-python.wasm` beside the compiled
  // output. Bare "import.meta" is empty under a cjs build; the shim
  // gives the cjs bundle an equivalent computed from `__filename`
  // instead, so grammar loading works from either entry point.
  shims: true,
});
