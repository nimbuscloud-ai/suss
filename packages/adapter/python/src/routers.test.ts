import { describe, expect, it } from "vitest";

import { assembleSummary } from "@suss/extractor";

import { discoverUnits } from "./discovery.js";
import { parsePython } from "./parser.js";
import { buildRouterIndex } from "./routers.js";
import { bindModule } from "./scope.js";

import type { RawCodeStructure } from "@suss/extractor";
import type {
  DecoratedClassRoute,
  DecoratedFunctionRoute,
  PythonPack,
} from "./pack.js";

/**
 * Everything a unit's summary says about what nobody could read, as one
 * string to match against. The adapter hands its readings over
 * uncollapsed, so the sentences only exist once the extractor has
 * assembled the summary.
 */
function unreadTextOf(unit: RawCodeStructure | undefined): string {
  return unit === undefined
    ? ""
    : assembleSummary(unit)
        .gaps.map((gap) => gap.description)
        .join("\n");
}

const fastapiLike: PythonPack = {
  name: "fastapi-test",
  protocol: "http",
  discovery: [
    {
      type: "decoratedFunctionRoute",
      importModule: ["fastapi"],
      verbAttributeNames: { get: "GET", post: "POST" },
      pathParamSyntax: "braces",
      routerComposition: {
        routerConstructorName: "APIRouter",
        includeMethodName: "include_router",
        prefixKeyword: "prefix",
      },
    },
  ],
};

/**
 * A class-decorator route shape whose mount reads the other way round:
 * a prefix at the mount call replaces the one the constructor stated
 * rather than going in front of it, and a constructor that states none
 * leaves the path to something this reading does not follow.
 */
const namespaceClassRoute: DecoratedClassRoute = {
  type: "decoratedClassRoute",
  importModule: ["flask_restx"],
  decoratorName: "route",
  verbMethodNames: { get: "GET", post: "POST" },
  pathParamSyntax: "flaskConverters",
  routerComposition: {
    routerConstructorName: "Namespace",
    includeMethodName: "add_namespace",
    prefixKeyword: "path",
    mountPrefixEffect: "replaces",
    constructorPrefixRequired: true,
    constructorPrefixTrailingSlash: "trimmed",
    noValuePrefix: "unstated",
  },
};

const namespaceLike: PythonPack = {
  name: "flask-restx-test",
  protocol: "http",
  discovery: [namespaceClassRoute],
};

async function unitsOf(source: string, packs: PythonPack[] = [fastapiLike]) {
  const tree = await parsePython(source);
  const module = bindModule(tree.rootNode);
  const routerIndex = buildRouterIndex(
    [{ file: "/proj/main.py", root: tree.rootNode, module }],
    packs,
    { roots: [] },
  );
  return discoverUnits(tree.rootNode, module, {
    packs,
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

  it("composes an empty prefix a library states, where that library adds nothing for one", async () => {
    // FastAPI's router with `prefix=""` really is mounted with no
    // prefix of its own, so the empty string reads as written. Only a
    // library that derives a path from elsewhere treats it as unsaid.
    const units = await unitsOf(
      [
        "from fastapi import FastAPI, APIRouter",
        "",
        "app = FastAPI()",
        'router = APIRouter(prefix="")',
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
    expect(unreadTextOf(units[0])).toBe("");
  });
});

describe("router prefix composition: abstentions", () => {
  async function abstained(source: string, name: string) {
    const units = await unitsOf(source);
    const unit = units.find((u) => u.identity.name === name);
    expect(unit).toBeDefined();
    const semantics = unit?.boundaryBinding?.semantics;
    expect(semantics?.name === "rest" ? semantics.path : "kept").toBeNull();
    return unreadTextOf(unit);
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

  it.each([
    ["the router's own prefix", "router = APIRouter(prefix=None)", ""],
    ["the mount call's prefix", "router = APIRouter()", ", prefix=None"],
  ])(
    "abstains when %s is written as None, for a library that wants a string there",
    async (_name, construction, mountArg) => {
      // FastAPI never gets to serve any of this: `None + path` stops
      // the app from starting. A library that reads no value as no
      // prefix says so in its pack, and this one does not.
      const reason = await abstained(
        [
          "from fastapi import FastAPI, APIRouter",
          "",
          "app = FastAPI()",
          construction,
          "",
          "",
          '@router.get("/ping")',
          "def ping():",
          "    pass",
          "",
          "",
          `app.include_router(router${mountArg})`,
          "",
        ].join("\n"),
        "ping",
      );
      expect(reason).toContain("prefix that is not a string literal");
    },
  );

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

describe("prefix composition for a class-decorator route", () => {
  const mounted = (lines: string[]) =>
    [
      "from flask_restx import Api, Namespace",
      "",
      'api = Api(title="Example")',
      'ns = Namespace("behaviors", path="/behaviors/<int:school_id>")',
      "",
      "",
      ...lines,
      "",
    ].join("\n");

  it("serves a route under the path its namespace was constructed with", async () => {
    const units = await unitsOf(
      mounted([
        '@ns.route("/<int:behavior_id>")',
        "class BehaviorDetail:",
        "    def get(self, school_id, behavior_id):",
        "        return {}",
        "",
        "",
        "api.add_namespace(ns)",
      ]),
      [namespaceLike],
    );
    expect(pathOf(units, "BehaviorDetail.get")).toBe(
      "/behaviors/{school_id}/{behavior_id}",
    );
  });

  it("reads an empty route path as the namespace's own path", async () => {
    // The idiom for a resource sitting at the mount point itself. The
    // composed path is what the namespace states, and the empty
    // argument adds nothing to it.
    const units = await unitsOf(
      mounted([
        '@ns.route("")',
        "class BehaviorList:",
        "    def get(self, school_id):",
        "        return []",
        "",
        "",
        "api.add_namespace(ns)",
      ]),
      [namespaceLike],
    );
    expect(pathOf(units, "BehaviorList.get")).toBe("/behaviors/{school_id}");
  });

  it("drops a trailing slash off the namespace path before joining the route's", async () => {
    // The library holds a namespace's path with trailing slashes
    // stripped, so `/trailing/` and `/trailing` serve the same paths.
    // Joining what the source wrote would report a doubled slash.
    const units = await unitsOf(
      [
        "from flask_restx import Api, Namespace",
        "",
        'api = Api(title="Example")',
        'ns = Namespace("trailing", path="/trailing/")',
        "",
        "",
        '@ns.route("/<int:item_id>")',
        "class TrailingDetail:",
        "    def get(self, item_id):",
        "        return {}",
        "",
        "",
        "api.add_namespace(ns)",
        "",
      ].join("\n"),
      [namespaceLike],
    );
    expect(pathOf(units, "TrailingDetail.get")).toBe("/trailing/{item_id}");
  });

  it("reads a namespace mounted at the root as adding nothing to the path", async () => {
    const units = await unitsOf(
      [
        "from flask_restx import Api, Namespace",
        "",
        'api = Api(title="Example")',
        'ns = Namespace("root", path="/")',
        "",
        "",
        '@ns.route("/<int:item_id>")',
        "class RootDetail:",
        "    def get(self, item_id):",
        "        return {}",
        "",
        "",
        "api.add_namespace(ns)",
        "",
      ].join("\n"),
      [namespaceLike],
    );
    expect(pathOf(units, "RootDetail.get")).toBe("/{item_id}");
  });

  it("classifies a parameter the namespace path names as a path parameter", async () => {
    const units = await unitsOf(
      mounted([
        '@ns.route("")',
        "class BehaviorList:",
        "    def get(self, school_id):",
        "        return []",
        "",
        "",
        "api.add_namespace(ns)",
      ]),
      [namespaceLike],
    );
    const list = units.find((u) => u.identity.name === "BehaviorList.get");
    expect(list?.parameters).toEqual([
      { name: "school_id", position: 1, role: "pathParams", typeText: null },
    ]);
  });

  it("leaves a request-body parameter its role when the path goes unread", async () => {
    // The request-body convention reads a parameter's annotation, not
    // the path, so it still answers where the path did not. Only the
    // roles that rest on the path go unnamed.
    const bodyPack: PythonPack = {
      name: "namespace-body-test",
      protocol: "http",
      discovery: [
        { ...namespaceClassRoute, annotatedClassIsRequestBody: true },
      ],
    };
    const units = await unitsOf(
      [
        "from flask_restx import Api, Namespace",
        "",
        'api = Api(title="Example")',
        'ns = Namespace("orders")',
        "",
        "",
        "class Order:",
        "    pass",
        "",
        "",
        '@ns.route("/<int:order_id>")',
        "class OrderDetail:",
        "    def post(self, order_id, payload: Order):",
        "        return {}",
        "",
        "",
        "api.add_namespace(ns)",
        "",
      ].join("\n"),
      [bodyPack],
    );
    const detail = units.find((u) => u.identity.name === "OrderDetail.post");
    expect(detail?.parameters.map((p) => [p.name, p.role])).toEqual([
      ["order_id", null],
      ["payload", "requestBody"],
    ]);
  });

  it("abstains when the mount overrides the path the namespace states", async () => {
    const units = await unitsOf(
      mounted([
        '@ns.route("/<int:behavior_id>")',
        "class BehaviorDetail:",
        "    def get(self, school_id, behavior_id):",
        "        return {}",
        "",
        "",
        'api.add_namespace(ns, path="/elsewhere")',
      ]),
      [namespaceLike],
    );
    expect(pathOf(units, "BehaviorDetail.get")).toBeNull();
    expect(unreadTextOf(units[0])).toContain(
      "is mounted under a prefix that replaces the one it was constructed with",
    );
  });

  it("abstains when the namespace states no path of its own", async () => {
    const units = await unitsOf(
      [
        "from flask_restx import Api, Namespace",
        "",
        'api = Api(title="Example")',
        'ns = Namespace("behaviors")',
        "",
        "",
        '@ns.route("/<int:behavior_id>")',
        "class BehaviorDetail:",
        "    def get(self, behavior_id):",
        "        return {}",
        "",
        "",
        "api.add_namespace(ns)",
        "",
      ].join("\n"),
      [namespaceLike],
    );
    expect(pathOf(units, "BehaviorDetail.get")).toBeNull();
    expect(unreadTextOf(units[0])).toContain(
      "states no prefix where it is constructed",
    );
  });

  it.each([
    ['path=""', 'path=""'],
    ["path=None", "path=None"],
    ["path=False", "path=False"],
    ["path=0", "path=0"],
    ["no path keyword", ""],
  ])(
    "abstains for a namespace whose path is written as %s, which its library reads as no path",
    async (_name, keyword) => {
      // Every one of these is falsy, and the library asks only that:
      // it serves all five under a path derived from the name.
      const units = await unitsOf(
        [
          "from flask_restx import Api, Namespace",
          "",
          'api = Api(title="Example")',
          `ns = Namespace("empty"${keyword === "" ? "" : `, ${keyword}`})`,
          "",
          "",
          '@ns.route("/<int:item_id>")',
          "class EmptyDetail:",
          "    def get(self, item_id):",
          "        return {}",
          "",
          "",
          "api.add_namespace(ns)",
          "",
        ].join("\n"),
        [namespaceLike],
      );
      expect(pathOf(units, "EmptyDetail.get")).toBeNull();
      expect(unreadTextOf(units[0])).toContain(
        "states no prefix where it is constructed",
      );
    },
  );

  it.each([
    ['path=""', 'path=""'],
    ["path=None", "path=None"],
    ["path=False", "path=False"],
    ["path=0", "path=0"],
  ])(
    "reads a mount whose path is written as %s as no override at all",
    async (_name, keyword) => {
      // The same falsiness runs on the mount side, so all four leave
      // the library serving the namespace where it was constructed.
      const units = await unitsOf(
        [
          "from flask_restx import Api, Namespace",
          "",
          'api = Api(title="Example")',
          'ns = Namespace("ctor", path="/ctor")',
          "",
          "",
          '@ns.route("/<int:item_id>")',
          "class CtorDetail:",
          "    def get(self, item_id):",
          "        return {}",
          "",
          "",
          `api.add_namespace(ns, ${keyword})`,
          "",
        ].join("\n"),
        [namespaceLike],
      );
      expect(pathOf(units, "CtorDetail.get")).toBe("/ctor/{item_id}");
    },
  );

  it("abstains when the same namespace is mounted twice", async () => {
    const units = await unitsOf(
      mounted([
        '@ns.route("/<int:behavior_id>")',
        "class BehaviorDetail:",
        "    def get(self, school_id, behavior_id):",
        "        return {}",
        "",
        "",
        "api.add_namespace(ns)",
        "api.add_namespace(ns)",
      ]),
      [namespaceLike],
    );
    expect(pathOf(units, "BehaviorDetail.get")).toBeNull();
    expect(unreadTextOf(units[0])).toContain("is mounted more than once");
  });

  it("abstains when nothing mounts the namespace", async () => {
    // A namespace nobody mounts serves nothing, and a namespace
    // mounted somewhere the run never read is the same reading from
    // here. Either way the route keeps its name and names no path.
    const units = await unitsOf(
      mounted([
        '@ns.route("/<int:behavior_id>")',
        "class BehaviorDetail:",
        "    def get(self, school_id, behavior_id):",
        "        return {}",
      ]),
      [namespaceLike],
    );
    expect(pathOf(units, "BehaviorDetail.get")).toBeNull();
    expect(unreadTextOf(units[0])).toContain(
      "is never mounted through a single variable binding in the files read",
    );
  });
});
