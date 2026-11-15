// The route table composer over entries written as JSX elements and as
// objects in a list, for a table shaped like React Router's, over ops
// written out by hand.

import { describe, expect, it } from "vitest";

import { discoverDeclared } from "./discovery.js";
import {
  composeRoutes,
  type RouteOutcome,
  type RouteTableDeclaration,
  type ServesRole,
} from "./routeTable.js";

import type {
  CallOps,
  CallScope,
  ModuleOps,
  RouteTableMatch,
  ValueOps,
} from "@suss/extractor";

interface Written {
  readonly source: string;
  /** What the value evaluates to, for a path. Unset reads as no word. */
  readonly word?: string;
  readonly flag?: boolean;
  readonly form?: string;
  readonly call?: CallOps;
  /** The function the value settles to. */
  readonly func?: ValueOps;
}

/** A value, whose adapter node is its source text, which the units say. */
function written(spec: Written): ValueOps {
  return {
    text: () => spec.word ?? null,
    flag: () => spec.flag ?? null,
    items: () => [],
    source: () => spec.source,
    form: () => spec.form ?? "other",
    evaluatedWith: () => spec.word ?? null,
    asCall: () => spec.call ?? null,
    function: () => spec.func ?? null,
    ast: () => spec.source,
  } as unknown as ValueOps;
}

const path = (word: string) => written({ source: JSON.stringify(word), word });
const opaque = (source: string) => written({ source });
const component = (name: string) =>
  written({
    source: name,
    form: "name",
    func: written({ source: `function ${name}` }),
  });
const unsettled = (name: string) => written({ source: name, form: "name" });
const yes = written({ source: "true", flag: true });
const no = written({ source: "false", flag: false });

function element(
  tag: string | ValueOps,
  attributes: Readonly<Record<string, ValueOps>> = {},
  ...within: ValueOps[]
): ValueOps {
  const tagged = typeof tag === "string" ? component(tag) : tag;
  return {
    ...written({ source: `<${tagged.source?.()}>`, form: "element" }),
    tag: () => tagged,
    attributes: () =>
      Object.entries(attributes).map(([key, value]) => ({ key, value })),
    elementsWithin: () => within,
  } as unknown as ValueOps;
}

function object(
  source: string,
  properties: Readonly<Record<string, ValueOps>>,
): ValueOps {
  return {
    ...written({ source, form: "object" }),
    ownProperty: (key: string) => properties[key] ?? null,
  } as unknown as ValueOps;
}

type Item = { readonly form: "value" | "spread"; readonly value: ValueOps };
const item = (value: ValueOps): Item => ({ form: "value", value });
const spread = (value: ValueOps): Item => ({ form: "spread", value });

function list(key: string, ...entries: Item[]): ValueOps {
  return {
    ...written({ source: key }),
    listed: () => ({ key, entries }),
  } as unknown as ValueOps;
}

function call(name: string, ...args: ValueOps[]): CallOps {
  return {
    method: () => null,
    calleeText: () => name,
    receiver: () => null,
    argumentCount: () => args.length,
    valueAt: (at: number) => args[at] ?? null,
    ast: () => `${name}(...)`,
  } as unknown as CallOps;
}

const NAMES = {
  R: "Route",
  Routes: "Routes",
  createBrowserRouter: "createBrowserRouter",
  createRoutesFromElements: "createRoutesFromElements",
};

interface FileSpec {
  readonly elements?: readonly ValueOps[];
  readonly calls?: readonly CallOps[];
  readonly names?: Readonly<Record<string, string>>;
  readonly mentions?: boolean;
  readonly scopes?: CallScope[];
}

function file(spec: FileSpec): ModuleOps {
  return {
    path: () => "/app/routes.tsx",
    calls: (scope: CallScope) => {
      spec.scopes?.push(scope);
      return spec.calls ?? [];
    },
    bodyCalls: () => [],
    elements: () => spec.elements ?? [],
    importedNames: () => new Map(Object.entries(spec.names ?? NAMES)),
    mentions: () => spec.mentions ?? true,
  } as unknown as ModuleOps;
}

const ROUTE: ServesRole = {
  role: "serves",
  methods: ["GET"],
  path: [{ key: "path" }],
  index: { key: "index" },
  handler: { value: [{ key: "element" }] },
  children: [{ in: "elements" }, { in: "list", pick: { key: "children" } }],
};

const ROUTER: RouteTableDeclaration = {
  roots: {
    kinds: { createBrowserRouter: 0 },
    children: { in: "list", pick: { at: 0 } },
    in: "file",
    elements: true,
  },
  roles: { Route: ROUTE },
  objects: "Route",
  from: ["react-router-dom"],
  absolutePaths: "standAlone",
  elementLists: ["createRoutesFromElements"],
  loops: [],
};

function outcomesOf(
  module: ModuleOps,
  table: RouteTableDeclaration = ROUTER,
): string[] {
  return composeRoutes(table, {
    files: [{ module, displayPath: "routes.tsx" }],
    ownerOf: () => ({ table: "app" }),
    include: () => null,
    naming: { singular: (word) => word, plural: (word) => word },
  }).outcomes.map(shown);
}

function shown(outcome: RouteOutcome): string {
  if (outcome.kind === "route") {
    return `${outcome.method} ${outcome.path} ${outcome.handler.source?.()}`;
  }
  if ("handler" in outcome) {
    return `${outcome.reason} ${outcome.handler.source?.()}`;
  }
  const where =
    "call" in outcome.at ? ` at ${outcome.at.call.calleeText()}` : "";
  return `${outcome.reason} ${outcome.value.source?.()}${where}`;
}

describe("a route table whose entries are elements", () => {
  it("nests each route under the routes around it, through an element no role reads", () => {
    const routes = element(
      "Routes",
      {},
      element(
        "R",
        { path: path("/users"), element: component("Layout") },
        element("R", { index: yes, element: component("List") }),
        element("R", { path: path(":id"), element: component("Detail") }),
        element(
          "Guard",
          {},
          element("R", { path: path("x"), element: component("X") }),
        ),
        element("R", { path: path("/help"), element: component("Help") }),
      ),
    );

    expect(outcomesOf(file({ elements: [routes] }))).toEqual([
      "GET /users Layout",
      "GET /users List",
      "GET /users/:id Detail",
      "GET /users/x X",
      "GET /help Help",
    ]);
  });

  it("serves nothing for an entry with neither a path nor an index that reads true, and walks its children under the scope", () => {
    const layout = element(
      "R",
      { element: component("Shell"), index: no },
      element("R", { path: path("board"), element: component("Board") }),
    );
    const top = element("R", { index: yes, element: component("Home") });

    expect(outcomesOf(file({ elements: [layout, top] }))).toEqual([
      "GET /board Board",
      "GET / Home",
    ]);
  });

  it("says why a path that does not read claims nothing, for the entry and every entry inside it", () => {
    const tree = element(
      "R",
      { path: opaque("base"), element: component("Tenant") },
      element("R", { path: path(":id"), element: component("Detail") }),
      element("R", { path: path("bare") }),
    );

    expect(outcomesOf(file({ elements: [tree] }))).toEqual([
      "pathUnread Tenant",
      "prefixUnread Detail",
    ]);
  });

  it("reads an element by the name its module exports it as, and nothing from a file that imports none of the table's names", () => {
    const aliased = element("Screen", {
      path: path("/"),
      element: component("Home"),
    });

    expect(
      outcomesOf(file({ elements: [aliased], names: { Screen: "Route" } })),
    ).toEqual(["GET / Home"]);
    expect(
      outcomesOf(file({ elements: [aliased], names: { Screen: "Other" } })),
    ).toEqual([]);
    expect(outcomesOf(file({ elements: [aliased], mentions: false }))).toEqual(
      [],
    );
  });
});

describe("a route table whose entries are objects in a list", () => {
  it("reads a router's objects and the lists nested under them, and says where a spread, an item that is no object and a list that does not read are", () => {
    const more = opaque("more");
    const made = written({ source: "make()", call: call("make") });
    const router = call(
      "createBrowserRouter",
      list(
        "routes",
        item(object("{home}", { path: path("/"), element: component("Home") })),
        item(
          object("{billing}", {
            path: path("/billing"),
            element: component("Shell"),
            children: list(
              "billingChildren",
              item(
                object("{index}", {
                  index: yes,
                  element: component("Overview"),
                }),
              ),
              item(
                object("{invoices}", {
                  path: path("invoices"),
                  children: opaque("invoiceRoutes"),
                }),
              ),
            ),
          }),
        ),
        spread(more),
        item(made),
      ),
    );

    expect(outcomesOf(file({ calls: [router] }))).toEqual([
      "GET / Home",
      "GET /billing Shell",
      "GET /billing Overview",
      "listUnread invoiceRoutes",
      "spread more",
      "notAnEntry make()",
    ]);
  });

  it("stops at a list reached again inside itself", () => {
    const entries: Item[] = [];
    const routes = {
      ...written({ source: "routes" }),
      listed: () => ({ key: "routes", entries }),
    } as unknown as ValueOps;
    entries.push(
      item(
        object("{home}", { path: path("/home"), element: component("Home") }),
      ),
      item(object("{self}", { path: path("/self"), children: routes })),
    );

    expect(
      outcomesOf(file({ calls: [call("createBrowserRouter", routes)] })),
    ).toEqual(["GET /home Home"]);
  });

  it("says a router's own list that does not read at the call, and reads elements handed to it where they are written", () => {
    const fromElements = call(
      "createBrowserRouter",
      written({
        source: "createRoutesFromElements(...)",
        call: call("createRoutesFromElements"),
      }),
    );
    const handedAnElement = call(
      "createBrowserRouter",
      written({ source: "<R />", form: "element" }),
    );
    const scopes: CallScope[] = [];

    expect(
      outcomesOf(
        file({
          calls: [
            call("createBrowserRouter", opaque("routes as never")),
            fromElements,
            handedAnElement,
            call("createBrowserRouter"),
          ],
          scopes,
        }),
      ),
    ).toEqual(["rootListUnread routes as never at createBrowserRouter"]);
    expect(scopes).toEqual(["file"]);
  });

  it("reads only calls in a list when the table reads no objects", () => {
    const { objects: _objects, from: _from, ...plain } = ROUTER;
    const table: RouteTableDeclaration = {
      ...plain,
      roots: { kinds: ROUTER.roots.kinds, children: ROUTER.roots.children },
    };
    const scopes: CallScope[] = [];

    expect(
      outcomesOf(
        file({
          calls: [
            call(
              "createBrowserRouter",
              list("routes", item(object("{home}", { path: path("/") }))),
            ),
          ],
          scopes,
        }),
        table,
      ),
    ).toEqual([]);
    expect(scopes).toEqual(["moduleBody"]);
  });
});

describe("a route table's other spellings", () => {
  const { from: _from, absolutePaths: _joined, ...asWritten } = ROUTER;

  it("matches tags as written when the table says no modules, and joins an absolute nested path under its parent", () => {
    const tree = element(
      "Route",
      { path: path("/a"), element: component("A") },
      element("Route", { path: path("/b"), element: component("B") }),
      element(opaque("Pages.Inner"), {}),
    );

    expect(outcomesOf(file({ elements: [tree] }), asWritten)).toEqual([
      "GET /a A",
      "GET /a/b B",
    ]);
  });

  it("serves an entry with a fixed path at the scope's own path, and reads no object whose role the table does not declare", () => {
    const fixed: RouteTableDeclaration = {
      ...asWritten,
      objects: "Missing",
      roles: {
        Route: ROUTE,
        Index: { ...ROUTE, path: { fixed: "scope" } },
      },
    };
    const tree = element(
      "Route",
      { path: path("/a") },
      element("Index", { element: component("Home") }),
    );
    const router = call(
      "createBrowserRouter",
      list("routes", item(object("{home}", { path: path("/") }))),
    );

    expect(
      outcomesOf(file({ elements: [tree], calls: [router] }), fixed),
    ).toEqual(["GET /a Home"]);
  });
});

describe("the units a route table declares", () => {
  const match: RouteTableMatch = {
    type: "routeTable",
    table: ROUTER,
    through: "element",
    unread: {
      pathUnread: "own path",
      prefixUnread: "enclosing path",
      spread: "spread",
      notAnEntry: "not an entry",
      rootListUnread: "router list",
      listUnread: "children list",
    },
  };

  function unitsOf(module: ModuleOps): string[] {
    return discoverDeclared(match, "component", module).map((unit) =>
      [
        unit.name,
        unit.nameKind ?? "binding",
        unit.func === null ? `at ${String(unit.announcedAt)}` : unit.func,
        unit.routeInfo === undefined
          ? unit.unreadBinding
          : `${unit.routeInfo.method} ${unit.routeInfo.path}`,
      ].join(" | "),
    );
  }

  it("puts a route on the component its element renders, at the entry when the component settles to no function, and labels any other handler by its path", () => {
    const routes = [
      element("R", { path: path("/profile"), element: element("Profile") }),
      element("R", {
        path: path("/ghost"),
        element: element(unsettled("Ghost")),
      }),
      element("R", {
        path: path("/member"),
        element: element(opaque("Pages.Inner")),
      }),
    ];

    expect(unitsOf(file({ elements: routes }))).toEqual([
      "Profile | binding | function Profile | GET /profile",
      "Ghost | binding | at <R> | GET /ghost",
      "/member | label | at <R> | GET /member",
    ]);
  });

  it("labels an entry whose path does not read by its component, else its own tag, else as a declaration", () => {
    const unread = opaque("base");
    const elements = [
      element("R", { path: unread, element: element("Team") }),
      element("R", { path: unread, element: opaque("someElement") }),
    ];
    const router = call(
      "createBrowserRouter",
      list(
        "routes",
        item(object("{team}", { path: unread, element: opaque("pick()") })),
      ),
    );

    expect(unitsOf(file({ elements, calls: [router] }))).toEqual([
      "declaration | label | at {team} | own path",
      "Team | label | at <R> | own path",
      "R | label | at <R> | own path",
    ]);
  });

  it("says where a list or an item did not read, by the callee of a call and the source text of anything else", () => {
    const router = call(
      "createBrowserRouter",
      list(
        "routes",
        spread(opaque("more")),
        item(written({ source: "make()", call: call("make") })),
      ),
    );
    const unlisted = call("createBrowserRouter", opaque("routes as never"));

    expect(unitsOf(file({ calls: [router, unlisted] }))).toEqual([
      "more | label | at more | spread",
      "make | label | at make() | not an entry",
      "routes as never | label | at createBrowserRouter(...) | router list",
    ]);
  });

  it("puts a route on the handler's own function when the pattern reads the handler as it is, and builds nothing for an entry that routes by name", () => {
    const { through: _through, ...asItIs } = match;
    const direct: RouteTableMatch = {
      ...asItIs,
      table: {
        ...ROUTER,
        roles: {
          ...ROUTER.roles,
          resources: {
            role: "expands",
            name: { key: "name" },
            rows: { index: [{ method: "GET", suffix: "" }] },
            controllerNaming: "plural",
            nested: "self",
            member: "self",
            children: { in: "elements" },
          },
        },
      },
    };
    const elements = [
      element("R", { path: path("/users"), element: component("Users") }),
      element("Res", { name: path("orders") }),
    ];
    const names = { ...NAMES, Res: "resources" };

    expect(
      discoverDeclared(direct, "component", file({ elements, names })).map(
        (unit) => `${unit.name} ${String(unit.func)}`,
      ),
    ).toEqual(["Users function Users"]);
  });
});
