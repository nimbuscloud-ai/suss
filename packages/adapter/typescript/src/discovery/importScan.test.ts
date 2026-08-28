import { describe, expect, it } from "vitest";

import { createTestProject } from "@suss/test-project";

import {
  importedNamesOf,
  importedRootsOf,
  namedImportsOf,
} from "./importScan.js";

import type { SourceFile } from "ts-morph";

function fileWith(source: string): SourceFile {
  const project = createTestProject();
  return project.createSourceFile("/probe.ts", source);
}

describe("the import scan", () => {
  it("maps local spellings to canonical exported names", () => {
    const file = fileWith(`
      import { Get as HttpGet, Post } from "@nestjs/common";
      import { Other } from "elsewhere";
    `);
    expect(importedNamesOf(file, ["@nestjs/common"])).toEqual(
      new Map([
        ["HttpGet", "Get"],
        ["Post", "Post"],
      ]),
    );
  });

  it("matches a subpath specifier only when asked to", () => {
    const file = fileWith(`
      import { createRoot } from "react-dom/client";
    `);
    expect(importedNamesOf(file, ["react-dom"]).size).toBe(0);
    expect(
      importedNamesOf(file, ["react-dom"], { subpaths: true }).get(
        "createRoot",
      ),
    ).toBe("createRoot");
  });

  it("collects default and namespace imports as roots", () => {
    const file = fileWith(`
      import ReactDOM from "react-dom";
      import * as Dom from "react-dom";
    `);
    expect(importedRootsOf(file, ["react-dom"])).toEqual(
      new Set(["ReactDOM", "Dom"]),
    );
  });

  it("says which specifier a named import came through", () => {
    const file = fileWith(`
      import { BehavioralSummarySchema } from "@suss/behavioral-ir/schemas";
    `);
    const [one] = namedImportsOf(file, ["@suss/behavioral-ir"], {
      subpaths: true,
    });
    expect(one).toMatchObject({
      local: "BehavioralSummarySchema",
      canonical: "BehavioralSummarySchema",
      specifier: "@suss/behavioral-ir/schemas",
    });
  });
});
