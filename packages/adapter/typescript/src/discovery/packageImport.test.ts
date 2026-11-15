import { describe, expect, it } from "vitest";

import { createTestProject } from "@suss/test-project";

import { ResolutionStore } from "../facts/store.js";
import { discoverUnits } from "./index.js";

describe("discoverPackageImports", () => {
  it("names a caller written in a quoted method or a quoted property by the key, without its quotes", () => {
    const project = createTestProject();
    project.createSourceFile(
      "/node_modules/hooks/package.json",
      JSON.stringify({ name: "hooks", types: "index.d.ts" }),
    );
    project.createSourceFile(
      "/node_modules/hooks/index.d.ts",
      "export declare function run(): void;",
    );
    const file = project.createSourceFile(
      "/consumer.ts",
      `
      import { run } from "hooks";
      export class Jobs {
        "nightly-run"() { run(); }
      }
      export const tasks = {
        "quick-run": () => run(),
      };
      `,
    );
    const units = discoverUnits(
      file,
      [
        {
          kind: "caller",
          match: { type: "packageImport", packages: ["hooks"] },
        },
      ],
      new ResolutionStore(),
    );

    expect(units.map((unit) => unit.name).sort()).toEqual([
      "nightly-run",
      "quick-run",
    ]);
  });
});
