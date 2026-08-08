import { describe, expect, it } from "vitest";

import { parsePython } from "./parser.js";
import { bindModule, resolveName } from "./scope.js";

async function bind(source: string) {
  const tree = await parsePython(source);
  return { root: tree.rootNode, binding: bindModule(tree.rootNode) };
}

describe("bindModule: imports", () => {
  it("binds a plain import to its top-level package name", async () => {
    const { binding } = await bind("import a.b.c\n");
    const a = binding.moduleScope.bindings.get("a");
    expect(a).toEqual({
      kind: "import",
      module: "a.b.c",
      relativeLevel: 0,
      localName: "a",
    });
  });

  it("binds an aliased plain import under the alias", async () => {
    const { binding } = await bind("import a.b.c as abc\n");
    expect(binding.moduleScope.bindings.has("a")).toBe(false);
    expect(binding.moduleScope.bindings.get("abc")).toEqual({
      kind: "import",
      module: "a.b.c",
      relativeLevel: 0,
      localName: "abc",
    });
  });

  it("binds a from-import under its own name", async () => {
    const { binding } = await bind("from myapp.wrappers.restx import route\n");
    expect(binding.moduleScope.bindings.get("route")).toEqual({
      kind: "importFrom",
      module: "myapp.wrappers.restx",
      relativeLevel: 0,
      importedName: "route",
    });
  });

  it("binds an aliased from-import under the alias, keeping the original name", async () => {
    const { binding } = await bind(
      "from myapp.wrappers.restx import route as api_route\n",
    );
    expect(binding.moduleScope.bindings.has("route")).toBe(false);
    expect(binding.moduleScope.bindings.get("api_route")).toEqual({
      kind: "importFrom",
      module: "myapp.wrappers.restx",
      relativeLevel: 0,
      importedName: "route",
    });
  });

  it("resolves relative import level and module", async () => {
    const { binding } = await bind("from ..pkg import thing\n");
    expect(binding.moduleScope.bindings.get("thing")).toEqual({
      kind: "importFrom",
      module: "pkg",
      relativeLevel: 2,
      importedName: "thing",
    });
  });

  it("resolves a bare relative import (no module after the dots)", async () => {
    const { binding } = await bind("from . import sibling\n");
    expect(binding.moduleScope.bindings.get("sibling")).toEqual({
      kind: "importFrom",
      module: "",
      relativeLevel: 1,
      importedName: "sibling",
    });
  });

  it("records a wildcard import as an open import rather than a name binding", async () => {
    const { binding } = await bind("from myapp.legacy import *\n");
    expect(binding.openImports).toEqual(["myapp.legacy"]);
    expect(binding.moduleScope.bindings.size).toBe(0);
  });
});

describe("bindModule: defs, classes, assignments", () => {
  it("binds a function name and builds its own function scope", async () => {
    const { root, binding } = await bind("def f(x, y):\n    pass\n");
    const funcNode = root.namedChild(0) as never;
    expect(binding.moduleScope.bindings.get("f")).toEqual({
      kind: "functionDef",
      node: funcNode,
    });
    const functionScope = binding.scopeFor.get((funcNode as { id: number }).id);
    expect(functionScope?.kind).toBe("function");
    expect(functionScope?.bindings.get("x")).toEqual({ kind: "parameter" });
    expect(functionScope?.bindings.get("y")).toEqual({ kind: "parameter" });
  });

  it("binds a class name and its methods within a class scope", async () => {
    const { root, binding } = await bind(
      "class C:\n    def m(self):\n        pass\n",
    );
    const classNode = root.namedChild(0) as never;
    expect(binding.moduleScope.bindings.get("C")).toEqual({
      kind: "classDef",
      node: classNode,
    });
    const classScope = binding.scopeFor.get((classNode as { id: number }).id);
    expect(classScope?.kind).toBe("class");
    expect(classScope?.bindings.get("m")?.kind).toBe("functionDef");
  });

  it("binds a decorated def/class under its own name, decorators aside", async () => {
    const { binding } = await bind(
      '@app.get("/x")\ndef handler():\n    pass\n',
    );
    expect(binding.moduleScope.bindings.get("handler")?.kind).toBe(
      "functionDef",
    );
  });

  it("binds a simple module-level assignment, carrying its value", async () => {
    const { binding } = await bind("app = FastAPI()\n");
    const app = binding.moduleScope.bindings.get("app");
    expect(app?.kind).toBe("assignment");
    expect(app?.kind === "assignment" && app.value?.type).toBe("call");
  });

  it("leaves a tuple-unpacking assignment unbound", async () => {
    const { binding } = await bind("a, b = 1, 2\n");
    expect(binding.moduleScope.bindings.has("a")).toBe(false);
    expect(binding.moduleScope.bindings.has("b")).toBe(false);
  });

  it("does not bind a definition nested inside an if-block (v0's unconditional-body boundary)", async () => {
    const { binding } = await bind("if True:\n    def f():\n        pass\n");
    expect(binding.moduleScope.bindings.has("f")).toBe(false);
  });
});

describe("resolveName", () => {
  it("resolves a name from the innermost scope outward", async () => {
    const { root, binding } = await bind(
      "import os\ndef f():\n    x = 1\n    return x\n",
    );
    const funcNode = root.namedChildren[1] as never;
    const functionScope = binding.scopeFor.get((funcNode as { id: number }).id);
    expect(functionScope).toBeDefined();
    expect(resolveName(functionScope as never, "x")).toEqual({
      kind: "assignment",
      value: expect.anything(),
    });
    expect(resolveName(functionScope as never, "os")?.kind).toBe("import");
    expect(resolveName(functionScope as never, "nope")).toBeNull();
  });

  it("a class scope answers its own lookups directly", async () => {
    const { root, binding } = await bind("class C:\n    field = 1\n");
    const classNode = root.namedChild(0) as never;
    const classScope = binding.scopeFor.get((classNode as { id: number }).id);
    expect(resolveName(classScope as never, "field")?.kind).toBe("assignment");
  });

  it("a method nested in a class does not see the class body's own bindings", async () => {
    const { root, binding } = await bind(
      "class C:\n    field = 1\n    def m(self):\n        return field\n",
    );
    const classNode = root.namedChild(0) as never;
    const classScope = binding.scopeFor.get((classNode as { id: number }).id);
    const methodBinding = classScope?.bindings.get("m");
    expect(methodBinding?.kind).toBe("functionDef");
    const methodNode =
      methodBinding?.kind === "functionDef" ? methodBinding.node : null;
    const methodScope = binding.scopeFor.get((methodNode as { id: number }).id);
    expect(resolveName(methodScope as never, "field")).toBeNull();
  });

  it("global redirects resolution to the module scope", async () => {
    const { root, binding } = await bind(
      "count = 0\ndef bump():\n    global count\n    count = count + 1\n",
    );
    const funcNode = root.namedChildren[1] as never;
    const functionScope = binding.scopeFor.get((funcNode as { id: number }).id);
    const resolved = resolveName(functionScope as never, "count");
    expect(resolved?.kind).toBe("assignment");
    expect(functionScope?.bindings.get("count")).toEqual({ kind: "global" });
  });

  it("nonlocal redirects resolution to the nearest enclosing function scope", async () => {
    const { root, binding } = await bind(
      "def outer():\n    total = 0\n    def inner():\n        nonlocal total\n        total = total + 1\n    return inner\n",
    );
    const outerNode = root.namedChild(0) as never;
    const outerScope = binding.scopeFor.get((outerNode as { id: number }).id);
    const innerDefNode = outerScope?.bindings.get("inner");
    expect(innerDefNode?.kind).toBe("functionDef");
    const innerNode =
      innerDefNode?.kind === "functionDef" ? innerDefNode.node : null;
    const innerScope = binding.scopeFor.get((innerNode as { id: number }).id);
    const resolved = resolveName(innerScope as never, "total");
    expect(resolved?.kind).toBe("assignment");
    expect(innerScope?.bindings.get("total")).toEqual({ kind: "nonlocal" });
  });

  it("nonlocal with no enclosing function binding resolves to null rather than falling through to module scope", async () => {
    const { root, binding } = await bind(
      "def outer():\n    def inner():\n        nonlocal missing\n    return inner\n",
    );
    const outerNode = root.namedChild(0) as never;
    const outerScope = binding.scopeFor.get((outerNode as { id: number }).id);
    const innerDefNode = outerScope?.bindings.get("inner");
    const innerNode =
      innerDefNode?.kind === "functionDef" ? innerDefNode.node : null;
    const innerScope = binding.scopeFor.get((innerNode as { id: number }).id);
    expect(resolveName(innerScope as never, "missing")).toBeNull();
  });
});
