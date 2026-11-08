import { describe, expect, it } from "vitest";

import { withDefinitionsInlined } from "@suss/behavioral-ir";
import { createTestProject } from "@suss/test-project";

import { withDefinitions } from "./definitions.js";
import { shapeFromNodeType } from "./typeShapes.js";

import type { TypeShape } from "@suss/behavioral-ir";
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

  describe("a call to an overloaded function", () => {
    const formatter = {
      "/formatter.ts": [
        "export interface OrderRow { id: number }",
        "export interface OrderView { id: string }",
        "export declare class OrderFormatter {",
        "  format(rows: OrderRow[]): OrderView[];",
        "  format(row: OrderRow): OrderView;",
        "}",
      ].join("\n"),
    };
    const callWith = (argument: string): Node =>
      lastInitializer(
        formatter,
        [
          'import { OrderFormatter, type OrderRow } from "./formatter.js";',
          "declare const formatter: OrderFormatter;",
          argument,
          "const value = formatter.format(row);",
        ].join("\n"),
      );

    it("reads the overload the argument picks", () => {
      expect(
        shapeFromNodeType(callWith("declare const row: OrderRow;")),
      ).toEqual({ type: "record", properties: { id: { type: "text" } } });
    });

    it("says nothing when an argument typed any could pick any overload", () => {
      expect(shapeFromNodeType(callWith("declare const row: any;"))).toEqual({
        type: "unknown",
      });
    });

    it("says nothing when the argument is typed never", () => {
      expect(shapeFromNodeType(callWith("declare const row: never;"))).toEqual({
        type: "unknown",
      });
    });
  });

  describe("named types written once", () => {
    const chain = (links: number): string =>
      [
        ...Array.from(
          { length: links },
          (_, at) => `interface Link${at} { next: Link${at + 1}; at: number }`,
        ),
        `interface Link${links} { at: number }`,
      ].join("\n");

    const namesIn = (definitions: Record<string, TypeShape> | null) =>
      Object.keys(definitions ?? {})
        .map((key) => key.slice(0, key.indexOf("@")))
        .sort();

    it("writes down the links of a long chain that a reader reaches, and names the next", () => {
      const node = lastInitializer(
        {},
        `${chain(3000)}\ndeclare const head: Link0;\nconst value = head;`,
      );

      const { value, definitions } = withDefinitions(() =>
        shapeFromNodeType(node),
      );

      expect(value).toMatchObject({ type: "ref", name: "Link0" });
      expect(namesIn(definitions)).toEqual([
        "Link0",
        "Link1",
        "Link2",
        "Link3",
        "Link4",
        "Link5",
      ]);
      // Read back out of the table, the chain is what a walk with no
      // table writes, down to the ref the depth cap leaves at Link6.
      const inlined = withDefinitionsInlined(
        value ?? UNKNOWN,
        definitions ?? undefined,
      );
      expect(inlined).toEqual(shapeFromNodeType(node));
    });

    it("writes down what a type refers to once a mention nearer the top reaches it", () => {
      const [far, near] = initializers(
        `${chain(10)}`,
        "interface Holder { a: { b: { c: { d: { link: Link0 } } } } }",
        "declare const holder: Holder;",
        "declare const head: Link0;",
        "const far = holder;",
        "const near = head;",
      );

      const farOnly = withDefinitions(() => shapeFromNodeType(far));
      const farFirst = withDefinitions(() => [
        shapeFromNodeType(far),
        shapeFromNodeType(near),
      ]);
      const nearFirst = withDefinitions(() => [
        shapeFromNodeType(near),
        shapeFromNodeType(far),
      ]);

      expect(namesIn(farOnly.definitions)).toEqual(["Holder", "Link0"]);
      expect(namesIn(farFirst.definitions)).toEqual([
        "Holder",
        "Link0",
        "Link1",
        "Link2",
        "Link3",
        "Link4",
        "Link5",
      ]);
      expect(nearFirst.definitions).toEqual(farFirst.definitions);
    });

    it("counts the levels of the merged record an intersection becomes, not the walk into its parts", () => {
      const [value] = initializers(
        `${chain(10)}`,
        "type Holder = { a: { b: { c: { d: Link0 } } } } & { z: number };",
        "declare const holder: Holder;",
        "const value = holder;",
      );

      const { definitions } = withDefinitions(() => shapeFromNodeType(value));

      // The merged record is the top, so Link0 is four levels down and the
      // ref to Link1 inside it is five.
      expect(namesIn(definitions)).toEqual(["Link0", "Link1"]);
    });

    it("writes down nothing for an intersection that comes out as its printed name", () => {
      const [value] = initializers(
        `${chain(10)}`,
        "declare const branded: Link0 & string;",
        "const value = branded;",
      );

      const read = withDefinitions(() => shapeFromNodeType(value));

      expect(read.value).toEqual({ type: "ref", name: "Link0 & string" });
      expect(read.definitions).toBeNull();
    });

    it("keeps the key only on a ref to a type the table wrote down", () => {
      const [far] = initializers(
        `${chain(10)}`,
        "interface Holder { a: { b: { c: { d: { link: Link0 } } } } }",
        "declare const holder: Holder;",
        "const far = holder;",
      );

      const { definitions } = withDefinitions(() => shapeFromNodeType(far));
      const link0 = Object.entries(definitions ?? {}).find(([key]) =>
        key.startsWith("Link0@"),
      )?.[1];

      expect(link0).toEqual({
        type: "record",
        properties: {
          next: { type: "ref", name: "Link1", from: "/in.ts" },
          at: { type: "number" },
        },
      });
    });
  });
});

const UNKNOWN: TypeShape = { type: "unknown" };

/** The initializer of every initialized `const` in `/in.ts`, written from `lines`. */
function initializers(...lines: string[]): Node[] {
  const project = createTestProject();
  const sf = project.createSourceFile("/in.ts", lines.join("\n"));
  return sf
    .getVariableStatements()
    .flatMap((statement) => statement.getDeclarations())
    .flatMap((declaration) => declaration.getInitializer() ?? []);
}
