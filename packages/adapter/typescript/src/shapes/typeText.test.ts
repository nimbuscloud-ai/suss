import { describe, expect, it } from "vitest";

import { createStrictTestProject } from "@suss/test-project";

import { shapeFromNodeType } from "./typeShapes.js";
import { stableTypeText } from "./typeText.js";

import type { Node } from "ts-morph";

/**
 * The initializer of the last `const` in `/in.ts`. With `primeFirst`, the
 * checker first reads the type of `early` in `/early.ts`, which creates
 * some of the same literal types sooner and so numbers them differently.
 */
function valueAfter(source: string, early: string, primeFirst: boolean): Node {
  const project = createStrictTestProject();
  const earlyFile = project.createSourceFile("/early.ts", early);
  const sf = project.createSourceFile("/in.ts", source);
  if (primeFirst) {
    earlyFile.getVariableDeclarationOrThrow("early").getType().getText();
  }
  const statements = sf.getVariableStatements();
  return statements[statements.length - 1]
    .getDeclarations()[0]
    .getInitializerOrThrow();
}

/** What the shape and the printed type come to, read cold and read primed. */
function bothWays(source: string, early: string) {
  return [false, true].map((primeFirst) => {
    const node = valueAfter(source, early, primeFirst);
    return {
      shape: shapeFromNodeType(node),
      text: stableTypeText(node.getType(), node),
    };
  });
}

describe("reading a type the same way whatever the checker read first", () => {
  it("orders a union's members the same way", () => {
    const [cold, primed] = bothWays(
      'declare const orderStatus: "open" | "closed";\nconst value = orderStatus;',
      'export declare const early: "closed";',
    );

    expect(primed).toEqual(cold);
    expect(cold.text).toBe('"closed" | "open"');
    expect(cold.shape).toEqual({
      type: "union",
      variants: [
        { type: "literal", value: "closed" },
        { type: "literal", value: "open" },
      ],
    });
  });

  it("orders the union inside a printed type the same way", () => {
    const [cold, primed] = bothWays(
      'declare const pending: Promise<"open" | "closed">;\nconst value = pending;',
      'export declare const early: "closed";',
    );

    expect(primed).toEqual(cold);
    expect(cold.shape).toEqual({
      type: "ref",
      name: 'Promise<"closed" | "open">',
    });
  });

  it("puts null and undefined last", () => {
    const node = valueAfter(
      "declare const maybe: undefined | null | number;\nconst value = maybe;",
      "export declare const early: number;",
      false,
    );

    expect(stableTypeText(node.getType(), node)).toBe(
      "number | null | undefined",
    );
  });

  it("lists a picked type's properties in the order they are declared", () => {
    const source = [
      "interface Order { id: string; status: string; total: number }",
      'declare const view: Pick<Order, "total" | "id">;',
      "const value = view;",
    ].join("\n");
    const [cold, primed] = bothWays(
      source,
      'export declare const early: "id";',
    );

    expect(primed).toEqual(cold);
    expect(Object.keys(recordProperties(cold.shape))).toEqual(["id", "total"]);
  });

  it("names a property keyed by a symbol the way the source writes it", () => {
    const node = valueAfter(
      [
        "class OrderError {",
        "  code = 1;",
        '  get [Symbol.toStringTag]() { return "OrderError"; }',
        "}",
        "declare const failure: OrderError;",
        "const value = failure;",
      ].join("\n"),
      "export declare const early: number;",
      false,
    );

    expect(Object.keys(recordProperties(shapeFromNodeType(node)))).toEqual([
      "code",
      "[Symbol.toStringTag]",
    ]);
  });
});

function recordProperties(shape: unknown): Record<string, unknown> {
  const record = shape as {
    type: string;
    properties?: Record<string, unknown>;
  };
  expect(record.type).toBe("record");
  return record.properties ?? {};
}
