// The route table composer over entries made on a value, as FastAPI and
// Express write them, found by the value their receiver comes to, over
// ops written out by hand.

import { describe, expect, it } from "vitest";

import { composeRoutes } from "./routeTable.js";
import { readRouteTable } from "./routeTableDiscovery.js";

import type {
  CallOps,
  DecoratedDefinition,
  ModuleOps,
  RouteOutcome,
  RouteTableDeclaration,
  RouteTableMatch,
  ServesRole,
  ValueOps,
} from "@suss/extractor";

const MAIN = "/app/main.py";
const ROUTES = "/app/routes/items.py";
const ELSEWHERE = "/lib/other.py";

let written = 0;

/** A key in source order, so the entries sort the way the test creates them. */
function siteIn(file: string): string {
  written += 10;
  return `${file}:${written}-${written + 5}`;
}

interface ValueSpec {
  readonly source: string;
  readonly word?: string;
  readonly literal?: string | number | boolean;
  readonly nothing?: boolean;
  /** The call a name or a field was written as. */
  readonly built?: CallOps;
  /** The collection a loop variable takes its elements from. */
  readonly element?: ValueOps;
  readonly list?: readonly ValueOps[];
  /** A class's methods, by name. */
  readonly methods?: readonly string[];
}

function value(spec: ValueSpec): ValueOps {
  return {
    source: () => spec.source,
    form: () => "other",
    evaluatedWith: () => spec.word ?? null,
    literal: () => spec.literal ?? null,
    nothing: () => spec.nothing ?? false,
    asCall: (how?: { follow: string }) =>
      how === undefined ? null : (spec.built ?? null),
    element: () => spec.element ?? null,
    items: () => spec.list ?? [],
    shape: () => (spec.list === undefined ? null : { type: "array" }),
    asClass: () =>
      spec.methods === undefined
        ? null
        : {
            members: () =>
              (spec.methods ?? []).map((name) => ({
                name,
                value: value({ source: `${spec.source}.${name}` }),
                line: null,
              })),
          },
    ast: () => spec.source,
  } as unknown as ValueOps;
}

const path = (word: string) =>
  value({ source: JSON.stringify(word), word, literal: word });
const opaque = (source: string) => value({ source });
const fn = (name: string) => value({ source: name });
const cls = (name: string, ...methods: string[]) =>
  value({ source: name, methods });

interface CallSpec {
  readonly name: string;
  /** The call that built the value the call is made on, or null for none. Unset writes the call bare. */
  readonly on?: CallOps | null;
  readonly args?: readonly ValueOps[];
  readonly keywords?: Readonly<Record<string, ValueOps>>;
  readonly file?: string;
  /** The function the call is written in, or null at the top of the file. */
  readonly caller?: string | null;
  readonly returns?: CallOps;
  readonly dropped?: boolean;
  /** What `receiverIsFrom` says. */
  readonly fromTable?: boolean;
}

function call(spec: CallSpec): CallOps {
  const file = spec.file ?? MAIN;
  const key = siteIn(file);
  const args = spec.args ?? [];
  const bare = spec.on === undefined;
  return {
    method: () => (bare ? null : spec.name),
    calleeText: () => (bare ? spec.name : `value.${spec.name}`),
    receiver: () => spec.on ?? null,
    site: () => key,
    file: () => file,
    argumentCount: () => args.length,
    valueAt: (at: number) => args[at] ?? null,
    keywordAt: (keyword: string) => spec.keywords?.[keyword] ?? null,
    returnedCall: () => spec.returns ?? null,
    dropped: () => spec.dropped ?? false,
    callerSite: () => spec.caller ?? null,
    receiverIsFrom: () => spec.fromTable ?? false,
    ast: () => `${spec.name}@${key}`,
  } as unknown as CallOps;
}

/** The definition under its decorators, top first. */
function under(
  definition: ValueOps,
  ...decorators: (CallOps | ValueOps)[]
): DecoratedDefinition {
  return {
    definition,
    decorators: decorators.map((decorator) =>
      "method" in decorator
        ? { form: "call", call: decorator as CallOps }
        : { form: "value", value: decorator as ValueOps },
    ),
  };
}

interface FileSpec {
  readonly path: string;
  readonly calls?: readonly CallOps[];
  readonly decorated?: readonly DecoratedDefinition[];
  readonly imports?: Readonly<Record<string, string>>;
}

const IMPORTS = { App: "App", Router: "Router", Namespace: "Namespace" };

function file(spec: FileSpec): { module: ModuleOps; displayPath: string } {
  const module = {
    path: () => spec.path,
    calls: () => spec.calls ?? [],
    decorated: () => spec.decorated ?? [],
    mentions: () => true,
    importedNames: () => new Map(Object.entries(spec.imports ?? IMPORTS)),
  } as unknown as ModuleOps;
  return { module, displayPath: spec.path };
}

const SERVES = (method: string): ServesRole => ({
  role: "serves",
  methods: [method],
  path: [{ at: 0 }, { keyword: "path" }],
  handler: { decorated: true },
});

const TABLE: RouteTableDeclaration = {
  roots: {
    kinds: { App: 0 },
    children: { in: "receiver" },
    in: "file",
    unlessDropped: { owned: ["middleware"] },
  },
  from: ["lib"],
  joins: "asWritten",
  loops: ["for"],
  throughWrappers: true,
  roles: {
    get: SERVES("GET"),
    post: SERVES("POST"),
    route: {
      role: "serves",
      methods: { members: ["get", "post"] },
      path: [{ at: 0 }],
      handler: { decorated: true },
    },
    handle: {
      role: "serves",
      methods: ["GET"],
      path: [{ at: 0 }],
      handler: { value: [{ at: 1 }] },
    },
    listed: {
      role: "serves",
      methods: { members: ["get"] },
      path: [{ at: 0 }],
      handler: { value: [{ at: 1 }] },
    },
    include: {
      role: "mount",
      table: [{ at: 0 }],
      at: [{ keyword: "prefix" }],
      prefix: "inFront",
    },
    add: {
      role: "mount",
      table: [{ at: 0 }],
      at: [{ keyword: "path" }],
      prefix: "replaces",
      noValue: "unstated",
    },
    Router: {
      role: "scopes",
      path: [{ keyword: "prefix" }],
      children: { in: "receiver" },
      noValue: "unreadable",
      trailingSlash: "kept",
    },
    Namespace: {
      role: "scopes",
      path: [{ keyword: "path" }],
      children: { in: "receiver" },
      noValue: "unstated",
      trailingSlash: "trimmed",
      prefixRequired: true,
    },
  },
};

function compose(
  files: readonly FileSpec[],
  table: RouteTableDeclaration = TABLE,
): readonly RouteOutcome[] {
  return composeRoutes(table, {
    files: files.map(file),
    ownerOf: () => ({ table: "app" }),
    include: () => null,
    naming: { singular: (word) => word, plural: (word) => word },
  }).outcomes;
}

/** Each outcome on a line: a route by its method, path and handler, and an unread one by its reason. */
function said(outcomes: readonly RouteOutcome[]): string[] {
  return outcomes.map((outcome) => {
    const handler = "handler" in outcome ? outcome.handler.source?.() : "";
    if (outcome.kind === "route") {
      return `${outcome.method} ${outcome.path} ${handler}`;
    }
    const loops =
      "loops" in outcome && outcome.loops !== undefined
        ? ` (${outcome.loops.length} loops)`
        : "";
    return `${outcome.reason} ${handler}${loops}`;
  });
}

const app = (spec: Partial<CallSpec> = {}) => call({ name: "App", ...spec });

function router(prefix?: ValueOps, spec: Partial<CallSpec> = {}): CallOps {
  return call({
    name: "Router",
    ...(prefix === undefined ? {} : { keywords: { prefix } }),
    ...spec,
  });
}

function get(
  on: CallOps | null,
  at: string,
  spec: Partial<CallSpec> = {},
): CallOps {
  return call({ name: "get", on, args: [path(at)], ...spec });
}

function include(
  on: CallOps,
  mounted: ValueOps,
  prefix?: ValueOps,
  spec: Partial<CallSpec> = {},
): CallOps {
  return call({
    name: "include",
    on,
    args: [mounted],
    ...(prefix === undefined ? {} : { keywords: { prefix } }),
    ...spec,
  });
}

function add(on: CallOps, mounted: ValueOps, at?: ValueOps): CallOps {
  return call({
    name: "add",
    on,
    args: [mounted],
    ...(at === undefined ? {} : { keywords: { path: at } }),
  });
}

/** A name written as the call that built it. */
const ref = (built: CallOps, source = "router") => value({ source, built });

/** A loop variable over a collection the table cannot list. */
const unlistable = () =>
  value({ source: "r", element: value({ source: "load()" }) });

describe("a route table whose entries are made on a value", () => {
  it("serves a decorated function on the app, and one on a router under the mount's prefix and its own, joined as written", () => {
    const root = app();
    const items = router(path("/items"));
    expect(
      said(
        compose([
          {
            path: MAIN,
            calls: [root, items, include(root, ref(items), path("/api"))],
            decorated: [
              under(fn("health"), get(root, "/health")),
              under(fn("item"), get(items, "/{id}")),
            ],
          },
        ]),
      ),
    ).toEqual(["GET /api/items/{id} item", "GET /health health"]);
  });

  it("finds a router's entries in another file, named the way that file names its constructor", () => {
    const root = app();
    const items = router(path("/items"), { file: ROUTES });
    expect(
      said(
        compose([
          { path: MAIN, calls: [root, include(root, ref(items))] },
          {
            path: ROUTES,
            calls: [items],
            decorated: [under(fn("list"), get(items, "", { file: ROUTES }))],
            imports: { Router: "Router" },
          },
        ]),
      ),
    ).toEqual(["GET /items list"]);
  });

  it("serves a router mounted twice under each mount", () => {
    const root = app();
    const items = router(path("/items"));
    expect(
      said(
        compose([
          {
            path: MAIN,
            calls: [
              root,
              items,
              include(root, ref(items), path("/v1")),
              include(root, ref(items), path("/v2")),
            ],
            decorated: [under(fn("list"), get(items, "/"))],
          },
        ]),
      ),
    ).toEqual(["GET /v1/items/ list", "GET /v2/items/ list"]);
  });

  it("reads a call made on the value whose handler is an argument, and no decorator of a role whose handler is not decorated", () => {
    const root = app();
    expect(
      said(
        compose([
          {
            path: MAIN,
            calls: [
              root,
              call({ name: "handle", on: root, args: [path("/x"), fn("h")] }),
              call({ name: "get", on: root, args: [path("/y"), fn("g")] }),
            ],
            decorated: [
              under(
                fn("decorated"),
                call({ name: "handle", on: root, args: [path("/z")] }),
                opaque("cached"),
              ),
            ],
          },
        ]),
      ),
    ).toEqual(["GET /x h"]);
  });

  it("serves each method of a decorated class the role lists, with the class as its owner", () => {
    const root = app();
    const outcomes = compose([
      {
        path: MAIN,
        calls: [root],
        decorated: [
          under(
            cls("Things", "get", "delete", "post"),
            call({ name: "route", on: root, args: [path("/things")] }),
          ),
          under(
            fn("notAClass"),
            call({ name: "route", on: root, args: [path("/other")] }),
          ),
        ],
      },
    ]);
    expect(said(outcomes)).toEqual([
      "GET /things Things.get",
      "POST /things Things.post",
    ]);
    expect(
      outcomes.map((outcome) =>
        "owner" in outcome ? outcome.owner?.source?.() : null,
      ),
    ).toEqual(["Things", "Things"]);
  });

  it("serves nothing from a role whose methods are a class's members but whose handler is an argument", () => {
    const root = app();
    expect(
      said(
        compose([
          {
            path: MAIN,
            calls: [
              root,
              call({ name: "listed", on: root, args: [path("/x"), fn("h")] }),
            ],
          },
        ]),
      ),
    ).toEqual([]);
  });

  it("reads a decorator through a project wrapper as the library call it returns, with the decorator's own arguments", () => {
    const root = app();
    const wrapped = call({
      name: "api_route",
      args: [path("/wrapped")],
      returns: get(root, "{path}"),
    });
    const files: FileSpec[] = [
      {
        path: MAIN,
        calls: [root],
        decorated: [
          under(fn("viaWrapper"), wrapped),
          under(fn("plainCall"), call({ name: "helper" })),
        ],
      },
    ];
    expect(said(compose(files))).toEqual(["GET /wrapped viaWrapper"]);
    expect(said(compose(files, { ...TABLE, throughWrappers: false }))).toEqual(
      [],
    );
  });

  it("reads a table with no decorated role, and one with no role found by its calls", () => {
    const root = app();
    const items = router();
    const express: RouteTableDeclaration = {
      roots: { kinds: { App: 0 }, children: { in: "receiver" }, in: "file" },
      from: ["lib"],
      loops: [],
      roles: {
        get: {
          role: "serves",
          methods: ["GET"],
          path: [{ at: 0 }],
          handler: { value: [{ at: 1 }] },
        },
        use: {
          role: "mount",
          table: [{ at: 1 }],
          at: [{ at: 0 }],
          prefix: "inFront",
        },
        Router: { role: "scopes", children: { in: "receiver" } },
      },
    };
    expect(
      said(
        compose(
          [
            {
              path: MAIN,
              calls: [
                root,
                items,
                call({
                  name: "use",
                  on: root,
                  args: [path("/api"), ref(items)],
                }),
                call({ name: "get", on: items, args: [path("/x"), fn("h")] }),
              ],
            },
          ],
          express,
        ),
      ),
    ).toEqual(["GET /api/x h"]);
    expect(
      said(
        compose(
          [
            {
              path: MAIN,
              calls: [root],
              decorated: [under(fn("f"), get(root, "/x"))],
            },
          ],
          { ...TABLE, roles: { get: SERVES("GET") } },
        ),
      ),
    ).toEqual(["GET /x f"]);
  });
});

describe("a route a table whose entries are made on a value claims no path for", () => {
  it("says a router nothing mounts is unreached, with nothing for a decorator on a value the table does not build", () => {
    const root = app();
    const orphan = router(path("/orphan"));
    const cache = call({ name: "Cache" });
    expect(
      said(
        compose([
          {
            path: MAIN,
            calls: [root, orphan, cache],
            decorated: [
              under(fn("lost"), get(orphan, "/x")),
              under(fn("cached"), get(cache, "/y")),
            ],
          },
        ]),
      ),
    ).toEqual(["unreached lost"]);
  });

  it("says a decorator whose receiver comes to no one value is unreached when that value is built from the table's modules", () => {
    const root = app();
    const files: FileSpec[] = [
      {
        path: MAIN,
        calls: [root],
        decorated: [
          under(fn("twice"), get(null, "/x", { fromTable: true })),
          under(fn("foreign"), get(null, "/y")),
        ],
      },
    ];
    expect(said(compose(files))).toEqual(["unreached twice"]);
    const { from: _from, ...anyModule } = TABLE;
    expect(said(compose(files, anyModule))).toEqual([]);
  });

  it("mounts each item of a list a for loop goes over, and says a router a loop the table cannot list may mount is unlistedLoop", () => {
    const root = app();
    const a = router(path("/a"));
    const b = router(path("/b"));
    const loadedFile = "/app/routes/loaded.py";
    const loaded = router(path("/loaded"), { file: loadedFile });
    const listed = value({
      source: "r",
      element: value({ source: "[a, b]", list: [ref(a, "a"), ref(b, "b")] }),
    });
    expect(
      said(
        compose([
          {
            path: MAIN,
            calls: [
              root,
              a,
              b,
              include(root, listed),
              include(root, unlistable()),
            ],
            decorated: [
              under(fn("inA"), get(a, "/x")),
              under(fn("inB"), get(b, "/y")),
            ],
          },
          {
            path: loadedFile,
            calls: [loaded],
            decorated: [
              under(fn("loadedRoute"), get(loaded, "/z", { file: loadedFile })),
            ],
          },
        ]),
      ),
    ).toEqual([
      "GET /a/x inA",
      "GET /b/y inB",
      "unlistedLoop loadedRoute (1 loops)",
    ]);
  });

  it("reads a loop over a list with an item that comes to no call as one it cannot list, and a loop the table does not read as nothing", () => {
    const root = app();
    const a = router(path("/a"));
    const looped = value({
      source: "r",
      element: value({ source: "[a, x]", list: [ref(a, "a"), opaque("x")] }),
    });
    const files: FileSpec[] = [
      {
        path: MAIN,
        calls: [root, a, include(root, looped)],
        decorated: [under(fn("inA"), get(a, "/x"))],
      },
    ];
    expect(said(compose(files))).toEqual(["unlistedLoop inA (1 loops)"]);
    expect(said(compose(files, { ...TABLE, loops: [] }))).toEqual([
      "unreached inA",
    ]);
  });

  it("says a router mounted in a function is a rivalled mount while a loop in another function nearby may mount it", () => {
    const root = app();
    const items = router(path("/items"), { file: ROUTES });
    expect(
      said(
        compose([
          {
            path: MAIN,
            calls: [
              root,
              include(root, ref(items), undefined, { caller: "main" }),
              include(root, unlistable(), undefined, { caller: "load" }),
              include(root, unlistable(), undefined, {
                file: ELSEWHERE,
                caller: "elsewhere",
              }),
            ],
          },
          {
            path: ROUTES,
            calls: [items],
            decorated: [under(fn("list"), get(items, "/", { file: ROUTES }))],
          },
        ]),
      ),
    ).toEqual(["rivalledMount list (1 loops)"]);
  });

  it("leaves a mount in a function alone when the only loop is in the same function", () => {
    const root = app();
    const items = router(path("/items"));
    expect(
      said(
        compose([
          {
            path: MAIN,
            calls: [
              root,
              items,
              include(root, ref(items), undefined, { caller: "main" }),
              include(root, unlistable(), undefined, { caller: "main" }),
            ],
            decorated: [under(fn("list"), get(items, "/"))],
          },
        ]),
      ),
    ).toEqual(["GET /items/ list"]);
  });

  it("walks the routes under a cycle once more with no path claimed", () => {
    const root = app();
    const a = router(path("/a"));
    const b = router(path("/b"));
    expect(
      said(
        compose([
          {
            path: MAIN,
            calls: [
              root,
              a,
              b,
              include(root, ref(a, "a")),
              include(a, ref(b, "b")),
              include(b, ref(a, "a")),
            ],
            decorated: [
              under(fn("inA"), get(a, "/x")),
              under(fn("inB"), get(b, "/y")),
            ],
          },
        ]),
      ),
    ).toEqual(["cycle inB", "cycle inA", "GET /a/b/y inB", "GET /a/x inA"]);
  });

  it("reads a router's own prefix and a mount's the way the library reads them", () => {
    const root = app();
    const unreadOwn = router(opaque("settings.PREFIX"));
    const unreadMount = router(path("/m"));
    const required = call({ name: "Namespace" });
    const nothing = call({
      name: "Namespace",
      keywords: { path: value({ source: "None", nothing: true }) },
    });
    const trimmed = call({
      name: "Namespace",
      keywords: { path: path("/ns/") },
    });
    const emptyMount = call({
      name: "Namespace",
      keywords: { path: path("/kept") },
    });
    const replaced = call({
      name: "Namespace",
      keywords: { path: path("/own") },
    });
    const zero = router(value({ source: "0", literal: 0 }));
    expect(
      said(
        compose([
          {
            path: MAIN,
            calls: [
              root,
              include(root, ref(unreadOwn), path("/api")),
              include(root, ref(unreadMount), opaque("prefix()")),
              add(root, ref(required)),
              add(root, ref(nothing)),
              add(root, ref(trimmed)),
              add(root, ref(emptyMount), value({ source: '""', literal: "" })),
              add(root, ref(replaced), path("/over")),
              include(root, ref(zero)),
            ],
            decorated: [
              under(fn("own"), get(unreadOwn, "/a")),
              under(fn("mount"), get(unreadMount, "/b")),
              under(fn("required"), get(required, "/c")),
              under(fn("nothing"), get(nothing, "/d")),
              under(fn("trimmed"), get(trimmed, "/e")),
              under(fn("emptyMount"), get(emptyMount, "/f")),
              under(fn("replaced"), get(replaced, "/g")),
              under(fn("zero"), get(zero, "/h")),
            ],
          },
        ]),
      ),
    ).toEqual([
      "prefixUnread own",
      "mountUnread mount",
      "prefixUnstated required",
      "prefixUnstated nothing",
      "GET /ns/e trimmed",
      "GET /kept/f emptyMount",
      "prefixReplaced replaced",
      "prefixUnread zero",
    ]);
  });

  it("says a decorator's own path that does not read is unread, once for each method of a class", () => {
    const root = app();
    expect(
      said(
        compose([
          {
            path: MAIN,
            calls: [root],
            decorated: [
              under(
                fn("pathless"),
                call({ name: "get", on: root, args: [opaque("p")] }),
              ),
              under(
                cls("Things", "get", "post"),
                call({ name: "route", on: root, args: [opaque("p")] }),
              ),
              under(fn("noPath"), call({ name: "get", on: root })),
            ],
          },
        ]),
      ),
    ).toEqual([
      "pathUnread pathless",
      "pathUnread Things.get",
      "pathUnread Things.post",
    ]);
  });

  it("leaves out a root its function drops, with every entry made on it, and says a router mounted only there is unreached", () => {
    const root = app({ dropped: true });
    const items = router(path("/items"));
    expect(
      said(
        compose([
          {
            path: MAIN,
            calls: [root, items, include(root, ref(items))],
            decorated: [
              under(fn("onApp"), get(root, "/x")),
              under(fn("onRouter"), get(items, "/y")),
            ],
          },
        ]),
      ),
    ).toEqual(["unreached onRouter"]);
  });

  it("leaves a mounted value alone when its file is not read, when it has no site, or when no role reads it", () => {
    const root = app();
    const away = router(path("/away"), { file: ELSEWHERE });
    const noSite = {
      ...(router(path("/nosite")) as object),
      site: undefined,
    } as unknown as CallOps;
    expect(
      said(
        compose([
          {
            path: MAIN,
            calls: [
              root,
              include(root, ref(away)),
              include(root, ref(noSite)),
              include(root, ref(call({ name: "Other" }))),
              include(root, opaque("x")),
            ],
          },
        ]),
      ),
    ).toEqual([]);
  });
});

describe("how a table puts a prefix and a path together as strings", () => {
  it("merges repeated slashes where the table says so", () => {
    const root = app();
    const items = router(path("/items/"));
    expect(
      said(
        compose(
          [
            {
              path: MAIN,
              calls: [root, items, include(root, ref(items))],
              decorated: [under(fn("list"), get(items, "/x"))],
            },
          ],
          { ...TABLE, joins: "merged" },
        ),
      ),
    ).toEqual(["GET /items/x list"]);
  });
});

describe("the units a table whose entries are made on a value declares", () => {
  it("says a reason the table gives a sentence for, and leaves it out for one it gives none", () => {
    const root = app();
    const orphan = router(path("/orphan"));
    const unread = {
      pathUnread: "path",
      prefixUnread: "prefix",
      spread: "spread",
      notAnEntry: "entry",
      rootListUnread: "root list",
      listUnread: "list",
    };
    const match: RouteTableMatch = {
      type: "routeTable",
      table: TABLE,
      unread: { ...unread, unreached: "never mounted" },
    };
    const { module } = file({
      path: MAIN,
      calls: [root, orphan],
      decorated: [
        under(fn("lost"), get(orphan, "/x")),
        under(
          fn("pathless"),
          call({ name: "get", on: root, args: [opaque("p")] }),
        ),
      ],
    });
    const units = (with_: RouteTableMatch) =>
      readRouteTable(with_, "handler", module).map((unit) => [
        unit.name,
        unit.unreadBinding ?? null,
      ]);
    expect(units(match)).toEqual([
      ["pathless", "path"],
      ["lost", "never mounted"],
    ]);
    expect(units({ ...match, unread })).toEqual([
      ["pathless", "path"],
      ["lost", null],
    ]);
  });
});
