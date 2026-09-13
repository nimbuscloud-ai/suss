// The parameter list the lowering hands the evaluator. What the
// evaluator then does with these names is covered in evaluator.test.ts.
import { describe, expect, it } from "vitest";

import { createTestProject } from "@suss/test-project";

import { typescriptLowering } from "./lowering.js";

import type { Parameter } from "@suss/values";
import type { Node } from "ts-morph";

/** The parameters of the single function declared in `source`. */
function parametersOf(source: string): readonly Parameter<Node>[] {
  const project = createTestProject();
  const file = project.createSourceFile("/repo.ts", source);
  const fn = file.getFunctionOrThrow("route");
  const shape = typescriptLowering({ rows: [] }).functionOf(fn);
  return shape?.parameters ?? [];
}

/** Each parameter as its name, the properties it reads, and its default. */
function shapesOf(source: string) {
  return parametersOf(source).map((parameter) => ({
    name: parameter.name,
    from: parameter.from ?? null,
    default: parameter.default?.getText() ?? null,
  }));
}

describe("parameter lowering", () => {
  it("keeps a plain parameter and its default", () => {
    expect(shapesOf(`function route(prefix = "/") { return prefix; }`)).toEqual(
      [{ name: "prefix", from: null, default: `"/"` }],
    );
  });

  it("gives an object binding pattern one name per property", () => {
    expect(
      shapesOf("function route({ prefix, method }: any) { return prefix; }"),
    ).toEqual([
      {
        name: "prefix",
        from: { position: 0, path: ["prefix"] },
        default: null,
      },
      {
        name: "method",
        from: { position: 0, path: ["method"] },
        default: null,
      },
    ]);
  });

  it("binds a renamed property to the local name", () => {
    expect(
      shapesOf("function route({ prefix: p }: any) { return p; }"),
    ).toEqual([
      { name: "p", from: { position: 0, path: ["prefix"] }, default: null },
    ]);
  });

  it("gives a nested pattern a path of two", () => {
    expect(
      shapesOf("function route({ opts: { prefix } }: any) { return prefix; }"),
    ).toEqual([
      {
        name: "prefix",
        from: { position: 0, path: ["opts", "prefix"] },
        default: null,
      },
    ]);
  });

  it("keeps an element default", () => {
    expect(
      shapesOf(`function route({ prefix = "/" }: any) { return prefix; }`),
    ).toEqual([
      {
        name: "prefix",
        from: { position: 0, path: ["prefix"] },
        default: `"/"`,
      },
    ]);
  });

  it("reads a quoted property name", () => {
    expect(
      shapesOf(`function route({ "x-prefix": p }: any) { return p; }`),
    ).toEqual([
      { name: "p", from: { position: 0, path: ["x-prefix"] }, default: null },
    ]);
  });

  it("says which argument a destructured name comes out of", () => {
    expect(
      shapesOf(
        "function route(base: string, { prefix }: any) { return base; }",
      ),
    ).toEqual([
      { name: "base", from: null, default: null },
      {
        name: "prefix",
        from: { position: 1, path: ["prefix"] },
        default: null,
      },
    ]);
  });

  it("drops a rest element, a computed property and an array pattern", () => {
    expect(
      shapesOf(
        "function route({ ...rest }: any, [first]: any[]) { return first; }",
      ),
    ).toEqual([]);
    expect(
      shapesOf(`const k = "p"; function route({ [k]: v }: any) { return v; }`),
    ).toEqual([]);
  });

  it("drops a pattern that carries a default of its own", () => {
    expect(
      shapesOf(
        `function route({ prefix }: any = { prefix: "/" }) { return prefix; }`,
      ),
    ).toEqual([]);
  });
});
