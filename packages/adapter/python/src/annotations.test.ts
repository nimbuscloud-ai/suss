import { describe, expect, it } from "vitest";

import {
  annotationToShape,
  collectedDefinitions,
  createAnnotationContext,
  shapeFromName,
} from "./annotations.js";
import { parsePython } from "./parser.js";
import { bindModule } from "./scope.js";

async function firstParamType(source: string) {
  const tree = await parsePython(source);
  const binding = bindModule(tree.rootNode);
  const funcStmt = tree.rootNode.namedChildren.find(
    (c) =>
      c !== null &&
      (c.type === "function_definition" || c.type === "decorated_definition"),
  );
  if (funcStmt === null || funcStmt === undefined) {
    throw new Error("expected a function definition");
  }
  const funcNode =
    funcStmt.type === "decorated_definition"
      ? funcStmt.childForFieldName("definition")
      : funcStmt;
  const parametersNode = funcNode?.childForFieldName("parameters");
  const param = parametersNode?.namedChild(0);
  const typeNode = param?.childForFieldName("type");
  if (typeNode === null || typeNode === undefined) {
    throw new Error("expected the first parameter to carry an annotation");
  }
  const scope = binding.scopeFor.get(tree.rootNode.id);
  if (scope === undefined) {
    throw new Error("expected a module scope");
  }
  return { typeNode, scope, ctx: createAnnotationContext(binding.scopeFor) };
}

describe("annotationToShape: scalars and builtins", () => {
  it.each([
    ["int", { type: "integer" }],
    ["float", { type: "number" }],
    ["str", { type: "text" }],
    ["bool", { type: "boolean" }],
    ["Any", { type: "unknown" }],
  ] as const)("reads %s", async (annotation, expected) => {
    const { typeNode, scope, ctx } = await firstParamType(
      `def f(x: ${annotation}):\n    pass\n`,
    );
    expect(annotationToShape(typeNode, scope, ctx)).toEqual(expected);
  });

  it("reads a bare list and dict as unknown-valued containers", async () => {
    const list = await firstParamType("def f(x: list):\n    pass\n");
    expect(annotationToShape(list.typeNode, list.scope, list.ctx)).toEqual({
      type: "array",
      items: { type: "unknown" },
    });
    const dict = await firstParamType("def f(x: dict):\n    pass\n");
    expect(annotationToShape(dict.typeNode, dict.scope, dict.ctx)).toEqual({
      type: "dictionary",
      values: { type: "unknown" },
    });
  });

  it("reads None as the null shape", async () => {
    const { typeNode, scope, ctx } = await firstParamType(
      "def f(x: None):\n    pass\n",
    );
    expect(annotationToShape(typeNode, scope, ctx)).toEqual({ type: "null" });
  });

  it("reads an unrecognized bare name as an opaque ref", async () => {
    const { typeNode, scope, ctx } = await firstParamType(
      "def f(x: SomeExternalType):\n    pass\n",
    );
    expect(annotationToShape(typeNode, scope, ctx)).toEqual({
      type: "ref",
      name: "SomeExternalType",
    });
  });
});

describe("annotationToShape: generics", () => {
  it("reads List[int] / list[int] as an array", async () => {
    const { typeNode, scope, ctx } = await firstParamType(
      "def f(x: list[int]):\n    pass\n",
    );
    expect(annotationToShape(typeNode, scope, ctx)).toEqual({
      type: "array",
      items: { type: "integer" },
    });
  });

  it("reads Dict[str, int] as a dictionary keyed on the value type", async () => {
    const { typeNode, scope, ctx } = await firstParamType(
      "def f(x: dict[str, int]):\n    pass\n",
    );
    expect(annotationToShape(typeNode, scope, ctx)).toEqual({
      type: "dictionary",
      values: { type: "integer" },
    });
  });

  it("reads Optional[str] as a union with null", async () => {
    const { typeNode, scope, ctx } = await firstParamType(
      "def f(x: Optional[str]):\n    pass\n",
    );
    expect(annotationToShape(typeNode, scope, ctx)).toEqual({
      type: "union",
      variants: [{ type: "text" }, { type: "null" }],
    });
  });

  it("reads Union[int, str] as a union of both", async () => {
    const { typeNode, scope, ctx } = await firstParamType(
      "def f(x: Union[int, str]):\n    pass\n",
    );
    expect(annotationToShape(typeNode, scope, ctx)).toEqual({
      type: "union",
      variants: [{ type: "integer" }, { type: "text" }],
    });
  });

  it("reads PEP 604 `X | None` the same as Optional[X]", async () => {
    const { typeNode, scope, ctx } = await firstParamType(
      "def f(x: int | None):\n    pass\n",
    );
    expect(annotationToShape(typeNode, scope, ctx)).toEqual({
      type: "union",
      variants: [{ type: "integer" }, { type: "null" }],
    });
  });

  it("reads an unrecognized generic as an opaque ref by its base name", async () => {
    const { typeNode, scope, ctx } = await firstParamType(
      "def f(x: Page[Todo]):\n    pass\n",
    );
    expect(annotationToShape(typeNode, scope, ctx)).toEqual({
      type: "ref",
      name: "Page",
    });
  });
});

describe("annotationToShape: local classes", () => {
  it("reads a locally-defined class as a record, filed once in definitions", async () => {
    const { typeNode, scope, ctx } = await firstParamType(
      "class TodoResponse:\n    id: int\n    title: str\n\n\ndef f(x: TodoResponse):\n    pass\n",
    );
    const shape = annotationToShape(typeNode, scope, ctx);
    expect(shape.type).toBe("ref");
    expect(shape.type === "ref" && shape.name).toBe("TodoResponse");
    const def = shape.type === "ref" ? shape.def : undefined;
    expect(def).toBeDefined();
    const definitions = collectedDefinitions(ctx);
    expect(definitions).not.toBeNull();
    expect(def !== undefined && definitions?.[def]).toEqual({
      type: "record",
      properties: { id: { type: "integer" }, title: { type: "text" } },
    });
  });

  it("only files annotated class-body assignments, not plain attributes", async () => {
    const { typeNode, scope, ctx } = await firstParamType(
      "class C:\n    annotated: int\n    plain = 1\n\n\ndef f(x: C):\n    pass\n",
    );
    const shape = annotationToShape(typeNode, scope, ctx);
    const def = shape.type === "ref" ? shape.def : undefined;
    const definitions = collectedDefinitions(ctx);
    expect(def !== undefined && definitions?.[def]).toEqual({
      type: "record",
      properties: { annotated: { type: "integer" } },
    });
  });

  it("reuses the same definitions-table entry for the same class mentioned twice", async () => {
    const tree = await parsePython(
      "class C:\n    id: int\n\n\ndef f(a: C, b: C):\n    pass\n",
    );
    const binding = bindModule(tree.rootNode);
    const funcNode = tree.rootNode.namedChildren[1];
    const parametersNode = funcNode?.childForFieldName("parameters");
    const [paramA, paramB] = parametersNode?.namedChildren ?? [];
    const scope = binding.scopeFor.get(tree.rootNode.id);
    if (
      scope === undefined ||
      paramA === null ||
      paramB === null ||
      paramA === undefined ||
      paramB === undefined
    ) {
      throw new Error("fixture did not parse as expected");
    }
    const ctx = createAnnotationContext(binding.scopeFor);
    const shapeA = annotationToShape(
      paramA.childForFieldName("type") as never,
      scope,
      ctx,
    );
    const shapeB = annotationToShape(
      paramB.childForFieldName("type") as never,
      scope,
      ctx,
    );
    expect(shapeA).toEqual(shapeB);
    expect(Object.keys(collectedDefinitions(ctx) ?? {})).toHaveLength(1);
  });

  it("stops at a self-referential model instead of recursing forever", async () => {
    const { scope, ctx } = await firstParamType(
      "class Node:\n    id: int\n\n\ndef f(x: Node):\n    pass\n",
    );
    expect(() => shapeFromName("Node", scope, ctx)).not.toThrow();
    expect(() => shapeFromName("Node", scope, ctx)).not.toThrow();
  });
});

describe("shapeFromName", () => {
  it("matches annotationToShape's identifier handling for a scalar", async () => {
    const { scope, ctx } = await firstParamType("def f(x: int):\n    pass\n");
    expect(shapeFromName("int", scope, ctx)).toEqual({ type: "integer" });
  });

  it("resolves a locally-defined class the same way a written annotation would", async () => {
    const { scope, ctx } = await firstParamType(
      "class TodoResponse:\n    id: int\n\n\ndef f(x: int):\n    pass\n",
    );
    const shape = shapeFromName("TodoResponse", scope, ctx);
    expect(shape.type).toBe("ref");
    expect(shape.type === "ref" && shape.def).toBeDefined();
  });
});
