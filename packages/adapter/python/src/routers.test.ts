import { describe, expect, it } from "vitest";

import { discoverUnits } from "./discovery.js";
import { parsePython } from "./parser.js";
import { buildRouterIndex } from "./routers.js";
import { bindModule } from "./scope.js";

import type { DecoratedFunctionRoute, PythonPack } from "./pack.js";

const fastapiLike: PythonPack = {
  name: "fastapi-test",
  protocol: "http",
  discovery: [
    {
      type: "decoratedFunctionRoute",
      importModule: ["fastapi"],
      verbAttributeNames: { get: "GET", post: "POST" },
      routerComposition: {
        routerConstructorName: "APIRouter",
        includeMethodName: "include_router",
        prefixKeyword: "prefix",
      },
    },
  ],
};

async function unitsOf(source: string) {
  const tree = await parsePython(source);
  const module = bindModule(tree.rootNode);
  const routerIndex = buildRouterIndex(
    [{ file: "/proj/main.py", root: tree.rootNode, module }],
    [fastapiLike],
    { roots: [] },
  );
  return discoverUnits(tree.rootNode, module, {
    packs: [fastapiLike],
    filePath: "main.py",
    routerIndex,
  });
}

function pathOf(units: Awaited<ReturnType<typeof unitsOf>>, name: string) {
  const unit = units.find((u) => u.identity.name === name);
  const semantics = unit?.boundaryBinding?.semantics;
  return semantics?.name === "rest" ? semantics.path : undefined;
}

describe("router prefix composition, one mount hop", () => {
  it("composes the mount prefix, the router's own prefix, and the route path", async () => {
    const units = await unitsOf(
      [
        "from fastapi import FastAPI, APIRouter",
        "",
        "app = FastAPI()",
        'router = APIRouter(prefix="/items")',
        "",
        "",
        '@router.get("/{item_id}")',
        "def read_item(item_id: int):",
        "    pass",
        "",
        "",
        'app.include_router(router, prefix="/api")',
        "",
      ].join("\n"),
    );
    expect(pathOf(units, "read_item")).toBe("/api/items/{item_id}");
  });

  it("classifies path parameters against the composed path", async () => {
    const units = await unitsOf(
      [
        "from fastapi import FastAPI, APIRouter",
        "",
        "app = FastAPI()",
        'router = APIRouter(prefix="/items")',
        "",
        "",
        '@router.get("/{item_id}")',
        "def read_item(item_id: int):",
        "    pass",
        "",
        "",
        "app.include_router(router)",
        "",
      ].join("\n"),
    );
    expect(pathOf(units, "read_item")).toBe("/items/{item_id}");
    const readItem = units.find((u) => u.identity.name === "read_item");
    expect(readItem?.parameters).toEqual([
      { name: "item_id", position: 0, role: "pathParams", typeText: "int" },
    ]);
  });

  it("treats an absent prefix keyword as an empty prefix on either side", async () => {
    const units = await unitsOf(
      [
        "from fastapi import FastAPI, APIRouter",
        "",
        "app = FastAPI()",
        "router = APIRouter()",
        "",
        "",
        '@router.get("/ping")',
        "def ping():",
        "    pass",
        "",
        "",
        'app.include_router(router, prefix="/api")',
        "",
      ].join("\n"),
    );
    expect(pathOf(units, "ping")).toBe("/api/ping");
  });

  it("leaves routes on the app itself alone", async () => {
    const units = await unitsOf(
      [
        "from fastapi import FastAPI",
        "",
        "app = FastAPI()",
        "",
        "",
        '@app.get("/health")',
        "def health():",
        "    pass",
        "",
      ].join("\n"),
    );
    expect(pathOf(units, "health")).toBe("/health");
    expect(units[0]?.unreadBinding).toBeUndefined();
  });
});

describe("router prefix composition: abstentions", () => {
  async function abstained(source: string, name: string) {
    const units = await unitsOf(source);
    const unit = units.find((u) => u.identity.name === name);
    expect(unit).toBeDefined();
    const semantics = unit?.boundaryBinding?.semantics;
    expect(semantics?.name === "rest" ? semantics.path : "kept").toBeNull();
    return unit?.unreadBinding;
  }

  it("abstains when the router's own prefix is not a string literal", async () => {
    const reason = await abstained(
      [
        "from fastapi import FastAPI, APIRouter",
        "",
        "app = FastAPI()",
        'PREFIX = "/items"',
        "router = APIRouter(prefix=PREFIX)",
        "",
        "",
        '@router.get("/ping")',
        "def ping():",
        "    pass",
        "",
        "",
        "app.include_router(router)",
        "",
      ].join("\n"),
      "ping",
    );
    expect(reason).toContain("declares a prefix that is not a string literal");
  });

  it("abstains when the mount call's prefix is not a string literal", async () => {
    const reason = await abstained(
      [
        "from fastapi import FastAPI, APIRouter",
        "",
        "app = FastAPI()",
        "router = APIRouter()",
        "",
        "",
        "def computed():",
        '    return "/api"',
        "",
        "",
        '@router.get("/ping")',
        "def ping():",
        "    pass",
        "",
        "",
        "app.include_router(router, prefix=computed())",
        "",
      ].join("\n"),
      "ping",
    );
    expect(reason).toContain(
      "is mounted with a prefix that is not a string literal",
    );
  });

  it("abstains when nothing mounts the router by name", async () => {
    const reason = await abstained(
      [
        "from fastapi import FastAPI, APIRouter",
        "",
        "app = FastAPI()",
        "router = APIRouter()",
        "",
        "",
        '@router.get("/ping")',
        "def ping():",
        "    pass",
        "",
      ].join("\n"),
      "ping",
    );
    expect(reason).toContain(
      "is never mounted through a single variable binding",
    );
  });

  it("abstains when the mount call reaches the router through a call, not a name", async () => {
    const reason = await abstained(
      [
        "from fastapi import FastAPI, APIRouter",
        "",
        "app = FastAPI()",
        "router = APIRouter()",
        "",
        "",
        "def pick_router():",
        "    return router",
        "",
        "",
        '@router.get("/ping")',
        "def ping():",
        "    pass",
        "",
        "",
        'app.include_router(pick_router(), prefix="/api")',
        "",
      ].join("\n"),
      "ping",
    );
    expect(reason).toContain(
      "is never mounted through a single variable binding",
    );
  });

  it("abstains when the router is mounted more than once", async () => {
    const reason = await abstained(
      [
        "from fastapi import FastAPI, APIRouter",
        "",
        "app = FastAPI()",
        "router = APIRouter()",
        "",
        "",
        '@router.get("/ping")',
        "def ping():",
        "    pass",
        "",
        "",
        'app.include_router(router, prefix="/v1")',
        'app.include_router(router, prefix="/v2")',
        "",
      ].join("\n"),
      "ping",
    );
    expect(reason).toContain("is mounted more than once");
  });

  it("abstains when the router's name is reassigned to a second construction", async () => {
    // FastAPI binds a route to whichever router the name held at
    // decoration time; this route lives on the first router while the
    // mount sees the second, so composing from either is a guess.
    const reason = await abstained(
      [
        "from fastapi import FastAPI, APIRouter",
        "",
        "app = FastAPI()",
        'router = APIRouter(prefix="/first")',
        "",
        "",
        '@router.get("/x")',
        "def read_x():",
        "    pass",
        "",
        "",
        'router = APIRouter(prefix="/second")',
        "",
        'app.include_router(router, prefix="/api")',
        "",
      ].join("\n"),
      "read_x",
    );
    expect(reason).toContain(
      "shares its variable name with a second router construction",
    );
  });

  it("abstains when the router is mounted onto another router", async () => {
    const reason = await abstained(
      [
        "from fastapi import FastAPI, APIRouter",
        "",
        "app = FastAPI()",
        "outer = APIRouter()",
        "inner = APIRouter()",
        "",
        "",
        '@inner.get("/ping")',
        "def ping():",
        "    pass",
        "",
        "",
        'outer.include_router(inner, prefix="/inner")',
        'app.include_router(outer, prefix="/outer")',
        "",
      ].join("\n"),
      "ping",
    );
    expect(reason).toContain("is mounted onto another router");
  });

  it("reads nothing from statements shaped past its one-hop rules", async () => {
    // Every statement here sits one step outside what the index
    // reads: an unbound mount argument, an import that resolves to no
    // file, a module object and a chained construction as the mount's
    // receiver, and assignments whose left or right side is not a
    // plain name given one constructor call. None of them may mount
    // the router, so its route abstains as never mounted.
    const reason = await abstained(
      [
        "from fastapi import FastAPI, APIRouter",
        "from missing_pkg import external_router",
        "import helpers",
        "",
        "app = FastAPI()",
        "obj = helpers.make()",
        "pair = (APIRouter(), 2)",
        "slots[0] = APIRouter()",
        "router = APIRouter()",
        "",
        "",
        '@router.get("/ping")',
        "def ping():",
        "    pass",
        "",
        "",
        "app.include_router(mystery)",
        'app.include_router(external_router, prefix="/api")',
        'helpers.include_router(router, prefix="/api")',
        'obj.include_router(router, prefix="/api")',
        "",
      ].join("\n"),
      "ping",
    );
    expect(reason).toContain(
      "is never mounted through a single variable binding",
    );
  });

  it("answers notRouter for a pattern that declared no composition", async () => {
    const tree = await parsePython(
      "from fastapi import APIRouter\n\nrouter = APIRouter()\n",
    );
    const module = bindModule(tree.rootNode);
    const routerIndex = buildRouterIndex(
      [{ file: "/proj/m.py", root: tree.rootNode, module }],
      [fastapiLike],
      { roots: [] },
    );
    const bare: DecoratedFunctionRoute = {
      type: "decoratedFunctionRoute",
      importModule: ["fastapi"],
      verbAttributeNames: { get: "GET" },
    };
    expect(routerIndex.resolve(bare, module, "router")).toEqual({
      kind: "notRouter",
    });
  });

  it("ignores a same-named mount method on an object nobody constructed from the module", async () => {
    const reason = await abstained(
      [
        "from fastapi import FastAPI, APIRouter",
        "from registry import Registry",
        "",
        "app = FastAPI()",
        "registry = Registry()",
        "router = APIRouter()",
        "",
        "",
        '@router.get("/ping")',
        "def ping():",
        "    pass",
        "",
        "",
        'registry.include_router(router, prefix="/api")',
        "",
      ].join("\n"),
      "ping",
    );
    expect(reason).toContain(
      "is never mounted through a single variable binding",
    );
  });
});
