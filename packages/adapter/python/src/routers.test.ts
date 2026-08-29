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
  RouterComposition,
} from "./pack.js";

/** Every gap description on a unit's summary, joined into one string to match against. */
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
        routerKeyword: "router",
        prefixKeyword: "prefix",
      },
    },
  ],
};

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
    [
      {
        file: "/proj/main.py",
        displayPath: "main.py",
        root: tree.rootNode,
        module,
      },
    ],
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

  it("composes a mount whose router is passed by keyword", async () => {
    // FastAPI's own signature names the parameter `router`, and a call
    // that writes it out used to mount nothing, because the reading took
    // the first positional argument and there was not one.
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
        'app.include_router(router=router, prefix="/api")',
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

  it("follows a prefix written as a name to the string it was assigned", async () => {
    // Every FastAPI project of any size writes `prefix=settings.API_V1`
    // or a module constant rather than a literal, and each one used to
    // lose the path on every route under that router.
    const units = await unitsOf(
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
    );
    expect(pathOf(units, "ping")).toBe("/items/ping");
  });

  it("follows a prefix written as a name at the mount too", async () => {
    const units = await unitsOf(
      [
        "from fastapi import FastAPI, APIRouter",
        "",
        "app = FastAPI()",
        'MOUNT = "/api/v1"',
        'router = APIRouter(prefix="/items")',
        "",
        "",
        '@router.get("/ping")',
        "def ping():",
        "    pass",
        "",
        "",
        "app.include_router(router, prefix=MOUNT)",
        "",
      ].join("\n"),
    );
    expect(pathOf(units, "ping")).toBe("/api/v1/items/ping");
  });

  it("abstains on a prefix nothing here can read", async () => {
    const reason = await abstained(
      [
        "from fastapi import FastAPI, APIRouter",
        "",
        "app = FastAPI()",
        "router = APIRouter(prefix=compute_prefix())",
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

  it("reads a router built through the module it was imported as", async () => {
    // `import fastapi` and then `fastapi.APIRouter(...)` used to produce
    // no summary at all, so those routes were missing rather than
    // unpathed and nobody could see they had gone.
    const units = await unitsOf(
      [
        "import fastapi",
        "",
        "app = fastapi.FastAPI()",
        'router = fastapi.APIRouter(prefix="/items")',
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
    expect(pathOf(units, "ping")).toBe("/api/items/ping");
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

  it("composes through a router mounted onto another router", async () => {
    const units = await unitsOf(
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
    );
    expect(pathOf(units, "ping")).toBe("/outer/inner/ping");
  });

  it("puts an intermediate router's constructor prefix into the chain", async () => {
    const units = await unitsOf(
      [
        "from fastapi import FastAPI, APIRouter",
        "",
        "app = FastAPI()",
        'outer = APIRouter(prefix="/o")',
        'inner = APIRouter(prefix="/i")',
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
    );
    expect(pathOf(units, "ping")).toBe("/outer/o/inner/i/ping");
  });

  it("abstains when a chain ends at a router nothing mounts", async () => {
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
        "",
      ].join("\n"),
      "ping",
    );
    expect(reason).toContain(
      "is mounted through a chain of routers this reading cannot compose",
    );
  });

  it("reads nothing from statements shaped past its one-hop rules", async () => {
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
      [
        {
          file: "/proj/m.py",
          displayPath: "m.py",
          root: tree.rootNode,
          module,
        },
      ],
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

  it("composes a path under an Api built from a spread dictionary", async () => {
    // `Api(**build_authorizations())` used to count the spread as the
    // first positional argument, so the mount reader saw two candidates
    // for what the Api was built from and declined the whole thing. Every
    // route under it came back with no path.
    const units = await unitsOf(
      [
        "from flask_restx import Api, Namespace",
        "",
        "def build_authorizations():",
        '    return {"authorizations": {}}',
        "",
        "api = Api(**build_authorizations())",
        'ns = Namespace("behaviors", path="/behaviors")',
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
    expect(pathOf(units, "BehaviorDetail.get")).toBe(
      "/behaviors/{behavior_id}",
    );
  });

  it("composes a path when a spread comes after a positional argument", async () => {
    const units = await unitsOf(
      [
        "from flask_restx import Api, Namespace",
        "",
        "def options():",
        '    return {"title": "Example"}',
        "",
        "api = Api(**options())",
        'ns = Namespace("reports", path="/reports")',
        "",
        '@ns.route("")',
        "class ReportList:",
        "    def get(self):",
        "        return []",
        "",
        "",
        "api.add_namespace(ns)",
        "",
      ].join("\n"),
      [namespaceLike],
    );
    expect(pathOf(units, "ReportList.get")).toBe("/reports");
  });

  it("reads an empty route path as the namespace's own path", async () => {
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

  it("composes a namespace mounted twice at the one path", async () => {
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
    expect(pathOf(units, "BehaviorDetail.get")).toBe(
      "/behaviors/{school_id}/{behavior_id}",
    );
  });

  it("abstains when nothing in the files read mounts the namespace", async () => {
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

describe("mounts written inside a function", () => {
  it("composes a router the app factory mounts", async () => {
    const units = await unitsOf(
      [
        "from fastapi import FastAPI, APIRouter",
        "",
        'router = APIRouter(prefix="/items")',
        "",
        "",
        '@router.get("/{item_id}")',
        "def read_item(item_id: int):",
        "    pass",
        "",
        "",
        "def create_app():",
        "    app = FastAPI()",
        '    app.include_router(router, prefix="/api")',
        "    return app",
        "",
      ].join("\n"),
    );
    expect(pathOf(units, "read_item")).toBe("/api/items/{item_id}");
  });

  it("composes a router a decorated factory mounts", async () => {
    const units = await unitsOf(
      [
        "from fastapi import FastAPI, APIRouter",
        "import functools",
        "",
        'router = APIRouter(prefix="/items")',
        "",
        "",
        '@router.get("/{item_id}")',
        "def read_item(item_id: int):",
        "    pass",
        "",
        "",
        "@functools.cache",
        "def create_app():",
        "    app = FastAPI()",
        '    app.include_router(router, prefix="/api")',
        "    return app",
        "",
      ].join("\n"),
    );
    expect(pathOf(units, "read_item")).toBe("/api/items/{item_id}");
  });

  it("composes a namespace the app factory adds", async () => {
    const units = await unitsOf(
      [
        "from flask_restx import Api, Namespace",
        "",
        'ns = Namespace("orders", path="/orders")',
        "",
        "",
        '@ns.route("/<int:order_id>")',
        "class Order:",
        "    def get(self, order_id):",
        "        return {}",
        "",
        "",
        "def create_app():",
        "    api = Api()",
        "    api.add_namespace(ns)",
        "    return api",
        "",
      ].join("\n"),
      [namespaceLike],
    );
    expect(pathOf(units, "Order.get")).toBe("/orders/{order_id}");
  });

  it("composes every router a loop over a literal list mounts", async () => {
    const units = await unitsOf(
      [
        "from fastapi import FastAPI, APIRouter",
        "",
        'items = APIRouter(prefix="/items")',
        'users = APIRouter(prefix="/users")',
        "",
        "",
        '@items.get("/{item_id}")',
        "def read_item(item_id: int):",
        "    pass",
        "",
        "",
        '@users.get("/{user_id}")',
        "def read_user(user_id: int):",
        "    pass",
        "",
        "",
        "def create_app():",
        "    app = FastAPI()",
        "    for router in [items, users]:",
        '        app.include_router(router, prefix="/api")',
        "    return app",
        "",
      ].join("\n"),
    );
    expect(pathOf(units, "read_item")).toBe("/api/items/{item_id}");
    expect(pathOf(units, "read_user")).toBe("/api/users/{user_id}");
  });

  it("composes every namespace a loop over a literal tuple adds", async () => {
    const units = await unitsOf(
      [
        "from flask_restx import Api, Namespace",
        "",
        'orders = Namespace("orders", path="/orders")',
        "",
        "",
        '@orders.route("/<int:order_id>")',
        "class Order:",
        "    def get(self, order_id):",
        "        return {}",
        "",
        "",
        "def create_app():",
        "    api = Api()",
        "    for namespace in (orders,):",
        "        api.add_namespace(namespace)",
        "    return api",
        "",
      ].join("\n"),
      [namespaceLike],
    );
    expect(pathOf(units, "Order.get")).toBe("/orders/{order_id}");
  });
});

describe("a loop that mounts what a call handed it", () => {
  const loopingFactory = [
    "from fastapi import FastAPI, APIRouter",
    "import loader",
    "",
    'router = APIRouter(prefix="/items")',
    "",
    "",
    '@router.get("/{item_id}")',
    "def read_item(item_id: int):",
    "    pass",
    "",
    "",
    "def create_app():",
    "    app = FastAPI()",
    "    for mounted in loader.load_routers():",
    "        app.include_router(mounted)",
    "    return app",
    "",
  ].join("\n");

  it("claims no path for a router the loop may or may not have mounted", async () => {
    const units = await unitsOf(loopingFactory);
    expect(pathOf(units, "read_item")).toBeNull();
  });

  it("names the file and line the loop is written at", async () => {
    const units = await unitsOf(loopingFactory);
    expect(unreadTextOf(units[0])).toContain(
      "is not mounted by name in the files read, and a loop at main.py:14 mounts routers read out of a call this reading does not follow",
    );
  });

  it("still composes a router the same function mounts by name", async () => {
    const units = await unitsOf(
      [
        "from fastapi import FastAPI, APIRouter",
        "import loader",
        "",
        'router = APIRouter(prefix="/items")',
        "",
        "",
        '@router.get("/{item_id}")',
        "def read_item(item_id: int):",
        "    pass",
        "",
        "",
        "def create_app():",
        "    app = FastAPI()",
        '    app.include_router(router, prefix="/api")',
        "    for mounted in loader.load_routers():",
        "        app.include_router(mounted)",
        "    return app",
        "",
      ].join("\n"),
    );
    expect(pathOf(units, "read_item")).toBe("/api/items/{item_id}");
  });

  it("reads a list holding anything but a bare name as a list it cannot enumerate", async () => {
    const units = await unitsOf(
      [
        "from fastapi import FastAPI, APIRouter",
        "",
        'router = APIRouter(prefix="/items")',
        "",
        "",
        '@router.get("/{item_id}")',
        "def read_item(item_id: int):",
        "    pass",
        "",
        "",
        "def create_app():",
        "    app = FastAPI()",
        "    for mounted in [router, build_extra()]:",
        "        app.include_router(mounted)",
        "    return app",
        "",
      ].join("\n"),
    );
    expect(pathOf(units, "read_item")).toBeNull();
    expect(unreadTextOf(units[0])).toContain(
      "mounts routers read out of a call this reading does not follow",
    );
  });

  it("reads a loop whose target is a tuple as naming no router either", async () => {
    const units = await unitsOf(
      [
        "from fastapi import FastAPI, APIRouter",
        "import loader",
        "",
        'router = APIRouter(prefix="/items")',
        "",
        "",
        '@router.get("/{item_id}")',
        "def read_item(item_id: int):",
        "    pass",
        "",
        "",
        "def create_app():",
        "    app = FastAPI()",
        "    for name, mounted in loader.load_routers():",
        "        app.include_router(mounted)",
        "    return app",
        "",
      ].join("\n"),
    );
    expect(pathOf(units, "read_item")).toBeNull();
    expect(unreadTextOf(units[0])).toContain(
      "mounts routers read out of a call this reading does not follow",
    );
  });
});

describe("a mount whose function may not be the one the app calls", () => {
  const twoFactories = [
    "from fastapi import FastAPI, APIRouter",
    "import loader",
    "",
    'router = APIRouter(prefix="/items")',
    "",
    "",
    '@router.get("/{item_id}")',
    "def read_item(item_id: int):",
    "    pass",
    "",
    "",
    "def create_test_app():",
    "    app = FastAPI()",
    '    app.include_router(router, prefix="/test")',
    "    return app",
    "",
    "",
    "def create_app():",
    "    app = FastAPI()",
    "    for mounted in loader.load_routers():",
    "        app.include_router(mounted)",
    "    return app",
    "",
  ].join("\n");

  it("claims no path when a test factory names the router and the app factory loops", async () => {
    const units = await unitsOf(twoFactories);
    expect(pathOf(units, "read_item")).toBeNull();
  });

  it("names the rival loop rather than the mount it happened to see", async () => {
    const units = await unitsOf(twoFactories);
    expect(unreadTextOf(units[0])).toContain(
      "is mounted inside a function, while a loop at main.py:20 mounts routers this reading cannot name, and which of them the app runs is not written down",
    );
  });

  it("keeps a module-level mount, which runs whichever function the app calls", async () => {
    const units = await unitsOf(
      [
        "from fastapi import FastAPI, APIRouter",
        "import loader",
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
        "",
        "def create_app():",
        "    other = FastAPI()",
        "    for mounted in loader.load_routers():",
        "        other.include_router(mounted)",
        "    return other",
        "",
      ].join("\n"),
    );
    expect(pathOf(units, "read_item")).toBe("/api/items/{item_id}");
  });

  it("counts a loop at a module's top level as a rival to a mount inside a function", async () => {
    const units = await unitsOf(
      [
        "from fastapi import FastAPI, APIRouter",
        "import loader",
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
        "for mounted in loader.load_routers():",
        "    app.include_router(mounted)",
        "",
        "",
        "def create_app():",
        "    other = FastAPI()",
        '    other.include_router(router, prefix="/api")',
        "    return other",
        "",
      ].join("\n"),
    );
    expect(pathOf(units, "read_item")).toBeNull();
    expect(unreadTextOf(units[0])).toContain(
      "is mounted inside a function, while a loop at main.py:13 mounts routers this reading cannot name",
    );
  });

  it("names every rival loop when more than one could have registered the router", async () => {
    const units = await unitsOf(
      [
        "from fastapi import FastAPI, APIRouter",
        "import loader",
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
        "for mounted in loader.load_routers():",
        "    app.include_router(mounted)",
        "",
        "for extra in loader.load_extras():",
        "    app.include_router(extra)",
        "",
        "",
        "def create_app():",
        "    other = FastAPI()",
        '    other.include_router(router, prefix="/api")',
        "    return other",
        "",
      ].join("\n"),
    );
    expect(unreadTextOf(units[0])).toContain(
      "while loops at main.py:13, main.py:16 mount routers this reading cannot name",
    );
  });

  it("keeps a mount two factories away from any loop it could rival", async () => {
    const units = await unitsOf(
      [
        "from fastapi import FastAPI, APIRouter",
        "",
        'router = APIRouter(prefix="/items")',
        "",
        "",
        '@router.get("/{item_id}")',
        "def read_item(item_id: int):",
        "    pass",
        "",
        "",
        "def create_test_app():",
        "    app = FastAPI()",
        "    return app",
        "",
        "",
        "def create_app():",
        "    app = FastAPI()",
        '    app.include_router(router, prefix="/api")',
        "    return app",
        "",
      ].join("\n"),
    );
    expect(pathOf(units, "read_item")).toBe("/api/items/{item_id}");
  });
});

describe("blocks the mount walk does not enter", () => {
  const mountInside = (header: string, indent: string) =>
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
      header,
      `${indent}app.include_router(router, prefix="/api")`,
      "",
    ].join("\n");

  it("does not read a mount written under an if", async () => {
    const units = await unitsOf(mountInside("if True:", "    "));
    expect(pathOf(units, "read_item")).toBeNull();
  });

  it("does not read a mount written under a try", async () => {
    const units = await unitsOf(
      mountInside("try:", "    ").replace(
        /\n$/,
        "\nexcept ImportError:\n    pass\n",
      ),
    );
    expect(pathOf(units, "read_item")).toBeNull();
  });

  it("does not read a mount written under a with", async () => {
    const units = await unitsOf(mountInside("with app.app_context():", "    "));
    expect(pathOf(units, "read_item")).toBeNull();
  });

  it("does not read a mount written in a class method", async () => {
    const units = await unitsOf(
      mountInside("class Factory:\n    def build(self):", "        "),
    );
    expect(pathOf(units, "read_item")).toBeNull();
  });

  it("does not read a mount written in a while", async () => {
    const units = await unitsOf(mountInside("while pending():", "    "));
    expect(pathOf(units, "read_item")).toBeNull();
  });

  it("does not read a mount inside a function the binder never scoped", async () => {
    const units = await unitsOf(
      mountInside("for _ in range(1):\n    def build():", "        "),
    );
    expect(pathOf(units, "read_item")).toBeNull();
  });

  it("reads a function whose body the parse never closed as holding no mount", async () => {
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
        "def create_app():",
      ].join("\n"),
    );
    expect(pathOf(units, "read_item")).toBeNull();
  });
});
describe("prefix composition through the object a mount is called on", () => {
  const blueprintComposition: RouterComposition = {
    routerConstructorName: "Namespace",
    includeMethodName: "add_namespace",
    prefixKeyword: "path",
    mountPrefixEffect: "replaces",
    constructorPrefixRequired: true,
    constructorPrefixTrailingSlash: "trimmed",
    noValuePrefix: "unstated",
    mountObjectPrefix: {
      prefixKeyword: "prefix",
      carrier: {
        importModule: ["flask"],
        constructorName: "Blueprint",
        argumentIndex: 0,
        prefixKeyword: "url_prefix",
        handoffMethodName: "init_app",
        registerMethodName: "register_blueprint",
      },
    },
  };

  const blueprintClassRoute: DecoratedClassRoute = {
    ...namespaceClassRoute,
    pathRepeatedSlashes: "merged",
    routerComposition: blueprintComposition,
  };

  const blueprintLike: PythonPack = {
    name: "flask-restx-blueprint-test",
    protocol: "http",
    discovery: [blueprintClassRoute],
  };

  /** The same composition on a pack that says nothing about repeated slashes. */
  const keptSlashesLike: PythonPack = {
    name: "flask-restx-kept-slashes-test",
    protocol: "http",
    discovery: [
      { ...namespaceClassRoute, routerComposition: blueprintComposition },
    ],
  };

  /** An app declaring one resource, with the lines building the `Api` and registering the blueprint left to the caller. */
  const app = (lines: string[]) =>
    [
      "from flask import Blueprint, Flask",
      "from flask_restx import Api, Namespace",
      "",
      ...lines,
      'ns = Namespace("orders", path="/orders")',
      "",
      "",
      '@ns.route("/<int:order_id>")',
      "class OrderDetail:",
      "    def get(self, order_id):",
      "        return {}",
      "",
      "",
      "api.add_namespace(ns)",
      "",
    ].join("\n");

  async function pathFor(lines: string[]) {
    const units = await unitsOf(app(lines), [blueprintLike]);
    return pathOf(units, "OrderDetail.get");
  }

  async function reasonFor(lines: string[]) {
    const units = await unitsOf(app(lines), [blueprintLike]);
    expect(pathOf(units, "OrderDetail.get")).toBeNull();
    return unreadTextOf(units[0]);
  }

  it("puts the blueprint's prefix in front of the namespace's path", async () => {
    expect(
      await pathFor([
        'bp = Blueprint("api", __name__, url_prefix="/api/v1")',
        "app = Flask(__name__)",
        "api = Api(bp)",
        "app.register_blueprint(bp)",
      ]),
    ).toBe("/api/v1/orders/{order_id}");
  });

  it("puts the Api's own prefix behind the blueprint's", async () => {
    expect(
      await pathFor([
        'bp = Blueprint("api", __name__, url_prefix="/api/v1")',
        "app = Flask(__name__)",
        'api = Api(bp, prefix="/extra")',
        "app.register_blueprint(bp)",
      ]),
    ).toBe("/api/v1/extra/orders/{order_id}");
  });

  it("serves a trailing slash on the blueprint's prefix at the merged path", async () => {
    // The library concatenates the prefix as written, leaving the rule
    // carrying two slashes, and Werkzeug serves that at the merged
    // path and redirects the written one.
    expect(
      await pathFor([
        'bp = Blueprint("api", __name__, url_prefix="/api/v1/")',
        "app = Flask(__name__)",
        "api = Api(bp)",
        "app.register_blueprint(bp)",
      ]),
    ).toBe("/api/v1/orders/{order_id}");
  });

  it("merges both doubled slashes when the blueprint's prefix and the Api's both trail", async () => {
    expect(
      await pathFor([
        'bp = Blueprint("api", __name__, url_prefix="/api/v1/")',
        "app = Flask(__name__)",
        'api = Api(bp, prefix="/extra/")',
        "app.register_blueprint(bp)",
      ]),
    ).toBe("/api/v1/extra/orders/{order_id}");
  });

  it("merges a doubled slash in front of a route declared on the Api itself", async () => {
    const units = await unitsOf(
      [
        "from flask import Blueprint, Flask",
        "from flask_restx import Api, Resource",
        "",
        'bp = Blueprint("api", __name__, url_prefix="/api/v1/")',
        "app = Flask(__name__)",
        "api = Api(bp)",
        "app.register_blueprint(bp)",
        "",
        "",
        '@api.route("/health")',
        "class Health:",
        "    def get(self):",
        "        return {}",
        "",
      ].join("\n"),
      [blueprintLike],
    );
    expect(pathOf(units, "Health.get")).toBe("/api/v1/health");
  });

  it("leaves a path alone for a library that does not merge repeated slashes", async () => {
    // The pack that says nothing gets what its source composed, which
    // is what FastAPI needs: Starlette serves the path as written.
    const units = await unitsOf(
      app([
        'bp = Blueprint("api", __name__, url_prefix="/api/v1/")',
        "app = Flask(__name__)",
        "api = Api(bp)",
        "app.register_blueprint(bp)",
      ]),
      [keptSlashesLike],
    );
    expect(pathOf(units, "OrderDetail.get")).toBe("/api/v1//orders/{order_id}");
  });

  it("adds nothing for a blueprint that states no prefix", async () => {
    expect(
      await pathFor([
        'bp = Blueprint("api", __name__)',
        "app = Flask(__name__)",
        "api = Api(bp)",
        "app.register_blueprint(bp)",
      ]),
    ).toBe("/orders/{order_id}");
  });

  it.each([
    ['url_prefix=""', 'url_prefix=""'],
    ["url_prefix=None", "url_prefix=None"],
    ["url_prefix=False", "url_prefix=False"],
    ["url_prefix=0", "url_prefix=0"],
  ])("adds nothing for a blueprint written %s", async (_name, written) => {
    expect(
      await pathFor([
        `bp = Blueprint("api", __name__, ${written})`,
        "app = Flask(__name__)",
        "api = Api(bp)",
        "app.register_blueprint(bp)",
      ]),
    ).toBe("/orders/{order_id}");
  });

  it("adds nothing for an Api built on the app itself", async () => {
    expect(await pathFor(["app = Flask(__name__)", "api = Api(app)"])).toBe(
      "/orders/{order_id}",
    );
  });

  it("adds nothing for an Api built with nothing to carry a prefix", async () => {
    expect(await pathFor(['api = Api(title="Example")'])).toBe(
      "/orders/{order_id}",
    );
  });

  it("reads a blueprint handed over after the Api was built", async () => {
    expect(
      await pathFor([
        'bp = Blueprint("api", __name__, url_prefix="/api/v1")',
        "app = Flask(__name__)",
        "api = Api()",
        "api.init_app(bp)",
        "app.register_blueprint(bp)",
      ]),
    ).toBe("/api/v1/orders/{order_id}");
  });

  /** A resource declared straight on the `Api` rather than on a namespace, which flask-restx serves off the Api's own default namespace. */
  const declaredOnApi = (lines: string[]) =>
    [
      "from flask import Blueprint, Flask",
      "from flask_restx import Api, Resource",
      "",
      ...lines,
      "",
      "",
      '@api.route("/health")',
      "class Health:",
      "    def get(self):",
      "        return {}",
      "",
    ].join("\n");

  it("puts the blueprint's prefix in front of a route declared on the Api itself", async () => {
    const units = await unitsOf(
      declaredOnApi([
        'bp = Blueprint("api", __name__, url_prefix="/api/v1")',
        "app = Flask(__name__)",
        "api = Api(bp)",
        "app.register_blueprint(bp)",
      ]),
      [blueprintLike],
    );
    expect(pathOf(units, "Health.get")).toBe("/api/v1/health");
  });

  it("leaves a route declared on an Api that carries no prefix as written", async () => {
    const units = await unitsOf(
      declaredOnApi(["app = Flask(__name__)", "api = Api(app)"]),
      [blueprintLike],
    );
    expect(pathOf(units, "Health.get")).toBe("/health");
    expect(unreadTextOf(units[0])).not.toContain("The router this route");
  });

  it("abstains on a route declared on an Api whose prefix nobody can read", async () => {
    const units = await unitsOf(
      declaredOnApi([
        "def computed():",
        '    return "/api/v1"',
        "",
        "",
        'bp = Blueprint("api", __name__, url_prefix=computed())',
        "api = Api(bp)",
      ]),
      [blueprintLike],
    );
    expect(pathOf(units, "Health.get")).toBeNull();
    expect(unreadTextOf(units[0])).toContain(
      "is built from one whose prefix is not a string literal",
    );
  });

  it("abstains when the Api is built from a call rather than a name", async () => {
    expect(
      await reasonFor([
        "def make_blueprint():",
        '    return Blueprint("api", __name__, url_prefix="/api/v1")',
        "",
        "",
        "api = Api(make_blueprint())",
      ]),
    ).toContain(
      "is mounted on an object that is built from something this reading cannot follow",
    );
  });

  it("abstains when the Api is both built with a blueprint and handed one", async () => {
    expect(
      await reasonFor([
        'bp = Blueprint("api", __name__, url_prefix="/api/v1")',
        'other = Blueprint("other", __name__, url_prefix="/api/v2")',
        "api = Api(bp)",
        "api.init_app(other)",
      ]),
    ).toContain(
      "is mounted on an object that is built from more than one candidate",
    );
  });

  it("abstains when the Api's own prefix is not a string literal", async () => {
    expect(
      await reasonFor([
        "def computed():",
        '    return "/extra"',
        "",
        "",
        'bp = Blueprint("api", __name__, url_prefix="/api/v1")',
        "api = Api(bp, prefix=computed())",
      ]),
    ).toContain(
      "is mounted on an object that states a prefix of its own that is not a string literal",
    );
  });

  it("abstains when the blueprint's prefix is not a string literal", async () => {
    expect(
      await reasonFor([
        "def computed():",
        '    return "/api/v1"',
        "",
        "",
        'bp = Blueprint("api", __name__, url_prefix=computed())',
        "api = Api(bp)",
      ]),
    ).toContain(
      "is mounted on an object that is built from one whose prefix is not a string literal",
    );
  });

  it("abstains when the blueprint's name holds a second construction", async () => {
    expect(
      await reasonFor([
        'bp = Blueprint("a", __name__, url_prefix="/api/v1")',
        'bp = Blueprint("b", __name__, url_prefix="/api/v2")',
        "app = Flask(__name__)",
        "api = Api(bp)",
        "app.register_blueprint(bp)",
      ]),
    ).toContain(
      "is mounted on an object that is built from one whose variable name holds a second construction",
    );
  });

  it("abstains when the registration states a prefix of its own", async () => {
    // The library reads `url_prefix=None` here as no override and
    // `url_prefix=""` as one, so a written keyword says nothing on its
    // own about where the routes land.
    expect(
      await reasonFor([
        'bp = Blueprint("api", __name__, url_prefix="/api/v1")',
        "app = Flask(__name__)",
        "api = Api(bp)",
        'app.register_blueprint(bp, url_prefix="/elsewhere")',
      ]),
    ).toContain(
      "is mounted on an object that is built from one registered under a prefix stated where it is registered",
    );
  });

  it("abstains when the blueprint is registered inside another blueprint", async () => {
    expect(
      await reasonFor([
        'outer = Blueprint("outer", __name__, url_prefix="/outer")',
        'bp = Blueprint("api", __name__, url_prefix="/api/v1")',
        "app = Flask(__name__)",
        "api = Api(bp)",
        "outer.register_blueprint(bp)",
        "app.register_blueprint(outer)",
      ]),
    ).toContain(
      "is mounted on an object that is built from one registered inside another",
    );
  });

  it("abstains when the blueprint is registered more than once", async () => {
    expect(
      await reasonFor([
        'bp = Blueprint("api", __name__, url_prefix="/api/v1")',
        "app = Flask(__name__)",
        "api = Api(bp)",
        "app.register_blueprint(bp)",
        "app.register_blueprint(bp)",
      ]),
    ).toContain(
      "is mounted on an object that is built from one registered more than once",
    );
  });
});

describe("a blueprint prefix and the site the mount is written at", () => {
  const blueprintLike: PythonPack = {
    name: "flask-restx-blueprint-site-test",
    protocol: "http",
    discovery: [
      {
        ...namespaceClassRoute,
        pathRepeatedSlashes: "merged",
        routerComposition: {
          ...namespaceClassRoute.routerComposition,
          routerConstructorName: "Namespace",
          includeMethodName: "add_namespace",
          prefixKeyword: "path",
          mountObjectPrefix: {
            prefixKeyword: "prefix",
            carrier: {
              importModule: ["flask"],
              constructorName: "Blueprint",
              argumentIndex: 0,
              prefixKeyword: "url_prefix",
              handoffMethodName: "init_app",
              registerMethodName: "register_blueprint",
            },
          },
        },
      },
    ],
  };

  /** An app whose namespace and resource are fixed, with the lines that build and mount left to the caller. */
  const app = (lines: string[]) =>
    [
      "from flask import Blueprint, Flask",
      "from flask_restx import Api, Namespace",
      "",
      'ns = Namespace("orders", path="/orders")',
      "",
      "",
      '@ns.route("/<int:order_id>")',
      "class OrderDetail:",
      "    def get(self, order_id):",
      "        return {}",
      "",
      "",
      ...lines,
      "",
    ].join("\n");

  async function pathFor(lines: string[]) {
    const units = await unitsOf(app(lines), [blueprintLike]);
    return pathOf(units, "OrderDetail.get");
  }

  it("puts the blueprint's prefix in front of a mount written inside a factory", async () => {
    expect(
      await pathFor([
        'bp = Blueprint("api", __name__, url_prefix="/api/v1")',
        "api = Api(bp)",
        "",
        "",
        "def create_app():",
        "    app = Flask(__name__)",
        "    api.add_namespace(ns)",
        "    app.register_blueprint(bp)",
        "    return app",
      ]),
    ).toBe("/api/v1/orders/{order_id}");
  });

  it("puts the blueprint's prefix in front of a mount written in a loop over a list", async () => {
    expect(
      await pathFor([
        'bp = Blueprint("api", __name__, url_prefix="/api/v1")',
        "api = Api(bp)",
        "",
        "",
        "def create_app():",
        "    app = Flask(__name__)",
        "    for namespace in [ns]:",
        "        api.add_namespace(namespace)",
        "    app.register_blueprint(bp)",
        "    return app",
      ]),
    ).toBe("/api/v1/orders/{order_id}");
  });

  it("reads the blueprint a factory builds beside the Api it builds", async () => {
    expect(
      await pathFor([
        "def create_app():",
        "    app = Flask(__name__)",
        '    bp = Blueprint("api", __name__, url_prefix="/api/v1")',
        "    api = Api(bp)",
        "    api.add_namespace(ns)",
        "    app.register_blueprint(bp)",
        "    return app",
      ]),
    ).toBe("/api/v1/orders/{order_id}");
  });

  it("reads the Api the mount is written beside, not a same-named one at the top of the file", async () => {
    // The factory's own `Api` is built on the app and has no
    // prefix; the module-level one on a blueprint serves nothing here.
    expect(
      await pathFor([
        'module_bp = Blueprint("module", __name__, url_prefix="/module")',
        "api = Api(module_bp)",
        "",
        "",
        "def create_app():",
        "    app = Flask(__name__)",
        "    api = Api(app)",
        "    api.add_namespace(ns)",
        "    return app",
      ]),
    ).toBe("/orders/{order_id}");
  });

  it("abstains on a loop over a call even when the blueprint states a prefix", async () => {
    const units = await unitsOf(
      app([
        'bp = Blueprint("api", __name__, url_prefix="/api/v1")',
        "api = Api(bp)",
        "",
        "",
        "def load():",
        "    return [ns]",
        "",
        "",
        "def create_app():",
        "    app = Flask(__name__)",
        "    for namespace in load():",
        "        api.add_namespace(namespace)",
        "    app.register_blueprint(bp)",
        "    return app",
      ]),
      [blueprintLike],
    );
    expect(pathOf(units, "OrderDetail.get")).toBeNull();
    expect(unreadTextOf(units[0])).toContain(
      "routers read out of a call this reading does not follow",
    );
  });
});

describe("a construction this reading cannot identify", () => {
  it("leaves a router built by a bare call undiscovered", async () => {
    const units = await unitsOf(
      [
        "from fastapi import FastAPI",
        "",
        "app = FastAPI()",
        "router = make_router()",
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
    );
    expect(units.find((u) => u.identity.name === "ping")).toBeUndefined();
  });

  it("leaves a router built through a module nobody imported undiscovered", async () => {
    const units = await unitsOf(
      [
        "import other",
        "",
        "from fastapi import FastAPI",
        "",
        "app = FastAPI()",
        'router = other.APIRouter(prefix="/x")',
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
    );
    expect(units.find((u) => u.identity.name === "ping")).toBeUndefined();
  });
});
