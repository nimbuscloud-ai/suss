// The route table composer over entries made on a value, as FastAPI and
// Express write them, found by the value their receiver comes to, over
// ops written out by hand.

import { describe, expect, it } from "vitest";

import { composeRoutes } from "./routeTable.js";
import { readRouteTable } from "./routeTableDiscovery.js";

import type {
  AstCapableOps,
  CallOps,
  DecoratedDefinition,
  ModuleOps,
  RouteOutcome,
  RouteTableDeclaration,
  RouteTableMatch,
  ScopesRole,
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
  /** The collection a loop takes each element of apart, with this value one of the parts. */
  readonly elementPart?: ValueOps;
  /** For a call, the items of the collection the rules settle it on returning. */
  readonly returned?: readonly ValueOps[];
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
    elementPart: () => spec.elementPart ?? null,
    returnedItems: () => spec.returned ?? null,
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
  /** The calls a receiver that comes to no one value is written as. */
  readonly shared?: readonly CallOps[];
  /** A module the file imports whole that the call is made on, `lib` in `lib.App()`. */
  readonly onModule?: string;
}

function call(spec: CallSpec): CallOps {
  const file = spec.file ?? MAIN;
  const key = siteIn(file);
  const args = spec.args ?? [];
  const bare = spec.on === undefined && spec.onModule === undefined;
  return {
    method: () => (bare ? null : spec.name),
    calleeText: () =>
      bare ? spec.name : `${spec.onModule ?? "value"}.${spec.name}`,
    receiver: () => spec.on ?? null,
    receiverCalls: () => spec.shared ?? [],
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
  /** The names the file binds to the table's modules imported whole. */
  readonly whole?: readonly string[];
  /** Each set of methods the composer says it will ask about the receivers of, by whether they are decorators or calls. */
  readonly asked?: string[];
}

const IMPORTS = { App: "App", Router: "Router", Namespace: "Namespace" };

function file(spec: FileSpec): { module: ModuleOps; displayPath: string } {
  const module = {
    path: () => spec.path,
    calls: () => spec.calls ?? [],
    decorated: () => spec.decorated ?? [],
    mentions: () => true,
    importedNames: () => new Map(Object.entries(spec.imports ?? IMPORTS)),
    importedWhole: () => new Set(spec.whole ?? []),
    readingReceivers: (methods: ReadonlySet<string>, of: string) => {
      spec.asked?.push(`${of}: ${[...methods].sort().join(" ")}`);
    },
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

/** The handler's name and where an outcome is: its method, the path in front of its own, the routers it came down through, and the routers its reason is about. */
function placed(outcomes: readonly RouteOutcome[]): string[] {
  const named = (one: CallOps | undefined) =>
    one === undefined
      ? "-"
      : String((one as Partial<AstCapableOps>).ast?.()).split("@")[0];
  return outcomes.map((outcome) => {
    if (!("handler" in outcome)) {
      return outcome.reason;
    }
    const mounts = (outcome.mounts ?? [])
      .map((hop) => `${named(hop.call)}>${named(hop.value)}`)
      .join(",");
    const where = `${outcome.handler.source?.()} ${outcome.method ?? "-"} prefix=${outcome.prefix ?? "-"} mounts=${mounts}`;
    if (outcome.kind === "route") {
      return where;
    }
    const shared = outcome.shared === true ? " shared" : "";
    return `${outcome.reason} ${where} on=${named(outcome.on)} router=${named(outcome.router)}${shared}`;
  });
}

/** A router built with a prefix, named so `placed` can tell it apart. */
function named(name: string, prefix?: ValueOps, spec: Partial<CallSpec> = {}) {
  const built = router(prefix, spec);
  return { ...built, ast: () => name } as CallOps;
}

describe("where a table whose entries are made on a value says a route is", () => {
  it("gives a route and an entry whose own path does not read the mounts down to their router and the path in front of their own", () => {
    const root = { ...app(), ast: () => "app" } as CallOps;
    const outer = named("outer", path("/o"));
    const inner = named("inner", path("/i"));
    const mountOuter = {
      ...include(root, ref(outer), path("/api")),
      ast: () => "mountOuter",
    } as CallOps;
    const mountInner = {
      ...include(outer, ref(inner)),
      ast: () => "mountInner",
    } as CallOps;
    expect(
      placed(
        compose([
          {
            path: MAIN,
            calls: [root, outer, inner, mountOuter, mountInner],
            decorated: [
              under(fn("route"), get(inner, "/x")),
              under(
                fn("pathless"),
                call({ name: "post", on: inner, args: [opaque("p")] }),
              ),
            ],
          },
        ]),
      ),
    ).toEqual([
      "route GET prefix=/api/o/i mounts=mountOuter>outer,mountInner>inner",
      "pathUnread pathless POST prefix=/api/o/i mounts=mountOuter>outer,mountInner>inner on=inner router=-",
    ]);
  });

  it("says which router a reason is about as a walk reaches it", () => {
    const root = app();
    const unread = named("unread", opaque("prefix()"));
    const below = named("below", path("/below"));
    const badMount = named("badMount", path("/m"));
    const a = named("a", path("/a"));
    const b = named("b", path("/b"));
    expect(
      placed(
        compose([
          {
            path: MAIN,
            calls: [
              root,
              include(root, ref(unread)),
              include(unread, ref(below)),
              include(root, ref(badMount), opaque("computed()")),
              include(root, ref(a)),
              include(a, ref(b)),
              include(b, ref(a)),
            ],
            decorated: [
              under(fn("onUnread"), get(unread, "/x")),
              under(fn("onBelow"), get(below, "/y")),
              under(fn("onBadMount"), get(badMount, "/z")),
              under(fn("inB"), get(b, "/w")),
            ],
          },
        ]),
      ).map((line) => line.replace(/ prefix=\S+ mounts=\S*/, "")),
    ).toEqual([
      "prefixUnread onBelow GET on=below router=unread",
      "prefixUnread onUnread GET on=unread router=unread",
      "mountUnread onBadMount GET on=badMount router=badMount",
      "cycle inB GET on=b router=a",
      "inB GET",
    ]);
  });
});

describe("why a table whose entries are made on a value says a router no walk reaches has no path", () => {
  it("reads the router's own prefix and each of its mounts the way a walk reads them, then the router it is mounted onto", () => {
    const root = app();
    const ownUnread = named("ownUnread", opaque("prefix()"));
    const lonely = named("lonely", path("/lonely"));
    const onLonely = named("onLonely", path("/x"));
    const badMount = named("badMount", path("/m"));
    const unreadParent = named("unreadParent", opaque("prefix()"));
    const onUnreadParent = named("onUnreadParent", path("/y"));
    const orphan = named("orphan");
    const foreign = call({ name: "Registry" });
    expect(
      placed(
        compose([
          {
            path: MAIN,
            calls: [
              root,
              include(lonely, ref(onLonely)),
              include(lonely, ref(badMount), opaque("computed()")),
              include(unreadParent, ref(onUnreadParent)),
              include(foreign, ref(orphan)),
            ],
            decorated: [
              under(fn("own"), get(ownUnread, "/a")),
              under(fn("onLonely"), get(onLonely, "/b")),
              under(fn("badMount"), get(badMount, "/c")),
              under(fn("onUnreadParent"), get(onUnreadParent, "/d")),
              under(fn("orphan"), get(orphan, "/e")),
            ],
          },
        ]),
      ).map((line) => line.replace(/ prefix=\S+ mounts=\S*/, "")),
    ).toEqual([
      "prefixUnread own GET on=ownUnread router=ownUnread",
      "unreached onLonely GET on=onLonely router=lonely",
      "mountUnread badMount GET on=badMount router=badMount",
      "prefixUnread onUnreadParent GET on=onUnreadParent router=unreadParent",
      "unreached orphan GET on=orphan router=-",
    ]);
  });

  it("says a router mounted in a function onto a router no walk reaches is rivalled by a loop elsewhere, and leaves out a loop on a value the table does not read", () => {
    const root = app();
    const lonely = named("lonely", path("/lonely"));
    const items = named("items", path("/items"));
    const registry = call({ name: "Registry" });
    const outcomes = compose([
      {
        path: MAIN,
        calls: [
          root,
          include(lonely, ref(items), undefined, { caller: "main" }),
          include(root, unlistable(), undefined, { caller: "load" }),
          include(registry, unlistable(), undefined, { caller: "load" }),
        ],
        decorated: [under(fn("list"), get(items, "/"))],
      },
    ]);
    expect(said(outcomes)).toEqual(["rivalledMount list (1 loops)"]);
  });

  it("says a mount whose path replaces the mounted value's own, and reads no prefix of a scope that reads none the library's way", () => {
    const root = app();
    const lonely = named("lonely", path("/lonely"));
    const ns = call({ name: "Namespace", keywords: { path: path("/ns") } });
    const plain = named("plain");
    const orphan = named("orphan", opaque("prefix()"));
    const files: FileSpec[] = [
      {
        path: MAIN,
        calls: [
          root,
          add(lonely, ref(ns), path("/over")),
          include(root, ref(plain)),
        ],
        decorated: [
          under(fn("replaced"), get(ns, "/a")),
          under(fn("plain"), get(plain, "/b")),
          under(fn("orphan"), get(orphan, "/c")),
        ],
      },
    ];
    expect(said(compose(files))).toEqual([
      "GET /b plain",
      "prefixReplaced replaced",
      "prefixUnread orphan",
    ]);
    const { noValue: _noValue, ...asWritten } = TABLE.roles
      .Router as ScopesRole;
    expect(
      said(
        compose(files, {
          ...TABLE,
          roles: { ...TABLE.roles, Router: asWritten },
        }),
      ),
    ).toEqual(["GET /b plain", "prefixReplaced replaced", "unreached orphan"]);
  });

  it("leaves out a router its function builds and drops, as it leaves out a root", () => {
    const root = app();
    const dropped = router(path("/d"), { dropped: true });
    expect(
      said(
        compose([
          {
            path: MAIN,
            calls: [root, dropped],
            decorated: [under(fn("gone"), get(dropped, "/x"))],
          },
        ]),
      ),
    ).toEqual([]);
  });

  it("serves an entry on a name assigned two roots at its own path, and says one on a name assigned two routers is shared", () => {
    const root = app();
    const other = app();
    const first = router(path("/first"));
    const second = router(path("/second"));
    const outcomes = compose([
      {
        path: MAIN,
        calls: [root, other, first, second, include(root, ref(second))],
        decorated: [
          under(fn("onApps"), get(null, "/x", { shared: [root, other] })),
          under(fn("onRouters"), get(null, "/y", { shared: [first, second] })),
          under(
            fn("onForeign"),
            get(null, "/z", { shared: [first, call({ name: "Registry" })] }),
          ),
        ],
      },
    ]);
    expect(said(outcomes)).toEqual(["GET /x onApps", "unreached onRouters"]);
    expect(
      outcomes.map((outcome) => "shared" in outcome && outcome.shared === true),
    ).toEqual([false, true]);
  });
});

describe("the files a table whose entries are made on a value reads", () => {
  it("reads a root and a router built on a module the file imports whole", () => {
    const root = app({ onModule: "lib" });
    const items = router(path("/items"), { onModule: "lib" });
    const notBuilt = call({ name: "get", onModule: "lib", args: [path("/x")] });
    expect(
      said(
        compose([
          {
            path: MAIN,
            calls: [root, items, notBuilt, include(root, ref(items))],
            decorated: [under(fn("list"), get(items, "/"))],
            imports: {},
            whole: ["lib"],
          },
        ]),
      ),
    ).toEqual(["GET /items/ list"]);
  });

  it("reads a loop that takes each element apart as one it cannot list", () => {
    const root = app();
    const items = router(path("/items"));
    const part = value({
      source: "r",
      elementPart: value({ source: "pairs()" }),
    });
    expect(
      said(
        compose([
          {
            path: MAIN,
            calls: [root, items, include(root, part)],
            decorated: [under(fn("list"), get(items, "/"))],
          },
        ]),
      ),
    ).toEqual(["unlistedLoop list (1 loops)"]);
  });

  it("mounts each item of the list a call the rules settle returns to a loop, and reads a call that returns none as one it cannot list", () => {
    const root = app();
    const a = router(path("/a"));
    const b = router(path("/b"));
    const looping = (returned?: readonly ValueOps[]) =>
      value({
        source: "r",
        element: value({
          source: "load()",
          ...(returned === undefined ? {} : { returned }),
        }),
      });
    const files = (over: ValueOps): FileSpec[] => [
      {
        path: MAIN,
        calls: [root, a, b, include(root, over)],
        decorated: [
          under(fn("inA"), get(a, "/x")),
          under(fn("inB"), get(b, "/y")),
        ],
      },
    ];
    expect(said(compose(files(looping([ref(a, "a"), ref(b, "b")]))))).toEqual([
      "GET /a/x inA",
      "GET /b/y inB",
    ]);
    expect(said(compose(files(looping([]))))).toEqual([
      "unlistedLoop inA (1 loops)",
      "unlistedLoop inB (1 loops)",
    ]);
    expect(said(compose(files(looping([ref(a, "a"), opaque("x")]))))).toEqual([
      "unlistedLoop inA (1 loops)",
      "unlistedLoop inB (1 loops)",
    ]);
  });

  it("says once in each file which decorators and which calls it will ask about the receivers of", () => {
    const root = app();
    const asked: string[] = [];
    compose([
      {
        path: MAIN,
        calls: [root],
        decorated: [under(fn("health"), get(root, "/health"))],
        asked,
      },
    ]);
    expect(asked).toEqual([
      "decorators: get post route",
      "calls: add handle include listed",
    ]);
  });
});
