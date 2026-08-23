import fs from "node:fs";

import { defineConfig } from "tsup";

// One entry per pack, so `@suss/packs/mongoose` reaches only the pack
// somebody asked for. The pack implementations are bundled in: they
// are workspace packages that are not published on their own, which is
// what keeps this to one npm package and one trusted publisher.
export default defineConfig({
  entry: fs
    .readdirSync("src")
    .filter((file) => file.endsWith(".ts"))
    .map((file) => `src/${file}`),
  format: ["esm"],
  dts: true,
  clean: true,
  noExternal: [/^@suss\/(framework|client)-/],
});
