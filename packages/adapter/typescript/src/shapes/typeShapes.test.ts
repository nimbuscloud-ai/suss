import { describe, expect, it } from "vitest";

import { createTestProject } from "@suss/test-project";

import { shapeFromNodeType } from "./typeShapes.js";

import type { Node } from "ts-morph";

/**
 * Build a project from the given files and return the initializer of the
 * last `const` in `/in.ts`, so a test can ask what the type checker says
 * about a value of a particular type.
 */
function lastInitializer(files: Record<string, string>, source: string): Node {
  const project = createTestProject();
  for (const [name, text] of Object.entries(files)) {
    project.createSourceFile(name, text);
  }
  const sf = project.createSourceFile("/in.ts", source);
  const statements = sf.getVariableStatements();
  const declaration = statements[statements.length - 1].getDeclarations()[0];
  return declaration.getInitializerOrThrow();
}

describe("shapeFromNodeType", () => {
  describe("types the project did not declare", () => {
    it("names a default-library type instead of expanding it", () => {
      const node = lastInitializer(
        {},
        "declare const el: HTMLElement;\nconst value = el;",
      );
      expect(shapeFromNodeType(node)).toEqual({
        type: "ref",
        name: "HTMLElement",
      });
    });

    it("names a dependency's type instead of expanding it", () => {
      const node = lastInitializer(
        {
          "/node_modules/dep/index.d.ts":
            "export interface DepThing { a: string; b: { c: number } }",
        },
        'import type { DepThing } from "dep";\ndeclare const d: DepThing;\nconst value = d;',
      );
      expect(shapeFromNodeType(node)).toEqual({
        type: "ref",
        name: "DepThing",
      });
    });

    it("keeps the array around a named dependency type", () => {
      const node = lastInitializer(
        {
          "/node_modules/dep/index.d.ts":
            "export interface DepThing { a: string }",
        },
        'import type { DepThing } from "dep";\ndeclare const d: DepThing[];\nconst value = d;',
      );
      expect(shapeFromNodeType(node)).toEqual({
        type: "array",
        items: { type: "ref", name: "DepThing" },
      });
    });
  });

  describe("types the project declared", () => {
    it("expands an interface written in the project", () => {
      const node = lastInitializer(
        {
          "/thing.ts": "export interface Thing { a: string; b: { c: number } }",
        },
        'import type { Thing } from "./thing.js";\ndeclare const t: Thing;\nconst value = t;',
      );
      expect(shapeFromNodeType(node)).toEqual({
        type: "record",
        properties: {
          a: { type: "text" },
          b: { type: "record", properties: { c: { type: "number" } } },
        },
      });
    });

    it("expands a mapped type a dependency declares over a project type", () => {
      const node = lastInitializer(
        {
          "/node_modules/dep/index.d.ts":
            "export type Boxed<T> = { [K in keyof T]: T[K] };",
          "/thing.ts": "export interface Thing { a: string; b: number }",
        },
        [
          'import type { Boxed } from "dep";',
          'import type { Thing } from "./thing.js";',
          "declare const t: Boxed<Thing>;",
          "const value = t;",
        ].join("\n"),
      );
      expect(shapeFromNodeType(node)).toEqual({
        type: "record",
        properties: { a: { type: "text" }, b: { type: "number" } },
      });
    });
  });
});
