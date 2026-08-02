import { Project } from "ts-morph";
import { describe, expect, it } from "vitest";

import { exportedDeclarationsOf } from "./moduleExports.js";

describe("exportedDeclarationsOf", () => {
  it("names what a module exports, following a re-export", () => {
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile("src/inner.ts", "export function deep() {}\n");
    const sf = project.createSourceFile(
      "src/outer.ts",
      "export { deep } from './inner.js';\nexport const shallow = 1;\n",
    );
    const exported = exportedDeclarationsOf(sf);
    expect([...exported.keys()].sort()).toEqual(["deep", "shallow"]);
    expect(exported.get("deep")?.[0].getSourceFile().getBaseName()).toBe(
      "inner.ts",
    );
  });

  it("answers a repeated ask with the map it already built", () => {
    const project = new Project({ useInMemoryFileSystem: true });
    const sf = project.createSourceFile("src/a.ts", "export const x = 1;\n");
    expect(exportedDeclarationsOf(sf)).toBe(exportedDeclarationsOf(sf));
  });
});
