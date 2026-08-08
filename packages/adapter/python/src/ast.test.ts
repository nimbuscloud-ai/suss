import { describe, expect, it } from "vitest";

import {
  bodyStatements,
  booleanLiteralValue,
  field,
  fields,
  isType,
  rangeOf,
  stringLiteralValue,
  stripDecorators,
} from "./ast.js";
import { parsePython } from "./parser.js";

async function moduleOf(source: string) {
  const tree = await parsePython(source);
  return tree.rootNode;
}

describe("stringLiteralValue", () => {
  it("reads a plain string literal", async () => {
    const root = await moduleOf('x = "/todos"\n');
    const assignment = root.namedChild(0)?.namedChild(0);
    const value = assignment?.childForFieldName("right");
    expect(
      value !== null && value !== undefined && stringLiteralValue(value),
    ).toBe("/todos");
  });

  it("returns null for an f-string with interpolation", async () => {
    const root = await moduleOf('x = f"/todos/{id}"\n');
    const assignment = root.namedChild(0)?.namedChild(0);
    const value = assignment?.childForFieldName("right");
    expect(
      value !== null && value !== undefined && stringLiteralValue(value),
    ).toBeNull();
  });

  it("returns null for a non-string node", async () => {
    const root = await moduleOf("x = 1\n");
    expect(stringLiteralValue(root)).toBeNull();
  });
});

describe("booleanLiteralValue", () => {
  it("reads True and False", async () => {
    const root = await moduleOf("a = True\nb = False\nc = 1\n");
    const [a, b, c] = root.namedChildren;
    const rightOf = (n: typeof a) =>
      n?.namedChild(0)?.childForFieldName("right") ?? null;
    expect(
      rightOf(a) !== null && booleanLiteralValue(rightOf(a) as never),
    ).toBe(true);
    expect(
      rightOf(b) !== null && booleanLiteralValue(rightOf(b) as never),
    ).toBe(false);
    expect(
      rightOf(c) !== null && booleanLiteralValue(rightOf(c) as never),
    ).toBeNull();
  });
});

describe("stripDecorators", () => {
  it("passes an undecorated definition through unchanged", async () => {
    const root = await moduleOf("def f():\n    pass\n");
    const stmt = root.namedChild(0);
    expect(stmt).not.toBeNull();
    const { definition, decorators } = stripDecorators(stmt as never);
    expect(definition.type).toBe("function_definition");
    expect(decorators).toHaveLength(0);
  });

  it("separates the decorators from a decorated definition", async () => {
    const root = await moduleOf('@a\n@b("x")\ndef f():\n    pass\n');
    const stmt = root.namedChild(0);
    const { definition, decorators } = stripDecorators(stmt as never);
    expect(definition.type).toBe("function_definition");
    expect(decorators).toHaveLength(2);
    expect(decorators.every((d) => d.type === "decorator")).toBe(true);
  });
});

describe("field / fields / isType / rangeOf / bodyStatements", () => {
  it("reads a named field and rejects an absent one", async () => {
    const root = await moduleOf("def f():\n    pass\n");
    const stmt = root.namedChild(0) as never;
    expect(field(stmt, "name")?.text).toBe("f");
    expect(field(stmt, "return_type")).toBeNull();
  });

  it("reads a multiple field as an array", async () => {
    const root = await moduleOf("import a, b\n");
    const stmt = root.namedChild(0) as never;
    expect(fields(stmt, "name").map((n) => n.text)).toEqual(["a", "b"]);
  });

  it("matches one of several types", async () => {
    const root = await moduleOf("x = 1\n");
    expect(isType(root, "module", "block")).toBe(true);
    expect(isType(root, "block")).toBe(false);
  });

  it("counts lines from one, the way the rest of the IR does", async () => {
    const root = await moduleOf("x = 1\n");
    expect(rangeOf(root).start).toBe(1);
  });

  it("answers a line number, not tree-sitter's byte offset, for a definition far down the file", async () => {
    const root = await moduleOf(
      `${"# padding\n".repeat(20)}def f():\n    pass\n`,
    );
    const definition = root.namedChild(root.namedChildCount - 1) as never;
    expect(rangeOf(definition).start).toBe(21);
  });

  it("lists a body's top-level statements", async () => {
    const root = await moduleOf("x = 1\ny = 2\n");
    expect(bodyStatements(root)).toHaveLength(2);
  });
});
