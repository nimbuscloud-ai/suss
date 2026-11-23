// The route table composer, one role at a time, over ops written out by
// hand for a table shaped like Rails' routes file.

import { describe, expect, it } from "vitest";

import { joinMountedPath } from "@suss/resolution";

import {
  composeRoutes,
  joinRoutePath,
  type RouteSources,
  type RouteTableDeclaration,
  type ServesRole,
} from "./routeTable.js";

import type { CallOps, Loop, ModuleOps, ValueOps } from "@suss/extractor";

interface ValueSpec {
  readonly word?: string;
  readonly source?: string;
  readonly name?: boolean;
  readonly list?: readonly ValueOps[];
  readonly flag?: boolean;
  readonly body?: readonly CallOps[];
  readonly call?: CallOps;
}

function value(spec: ValueSpec): ValueOps {
  return {
    text: () => spec.word ?? null,
    flag: () => spec.flag ?? null,
    items: () => spec.list ?? [],
    source: () => spec.source ?? spec.word ?? "",
    form: () => (spec.name === true ? "name" : "other"),
    shape: () => (spec.list === undefined ? null : { type: "array" }),
    evaluatedWith: (bindings: ReadonlyMap<string, string>) =>
      spec.name === true
        ? (bindings.get(spec.source ?? "") ?? null)
        : (spec.word ?? null),
    bodyCalls: () => spec.body ?? [],
    asCall: () => spec.call ?? null,
  } as unknown as ValueOps;
}

const word = (text: string) => value({ word: text });
const ref = (name: string) => value({ source: name, name: true });
const list = (...items: ValueOps[]) => value({ list: items });
const flag = (set: boolean) => value({ flag: set });

interface CallSpec {
  readonly args?: readonly ValueOps[];
  readonly keywords?: Readonly<Record<string, ValueOps>>;
  readonly pairs?: readonly (readonly [ValueOps, ValueOps])[];
  readonly block?: readonly CallOps[];
  readonly on?: CallOps;
  readonly onText?: string;
  readonly loop?: Loop;
}

function call(name: string, spec: CallSpec = {}): CallOps {
  const receiverText = spec.on?.calleeText() ?? spec.onText;
  const args = spec.args ?? [];
  return {
    method: () => (receiverText === undefined ? null : name),
    calleeText: () =>
      receiverText === undefined ? name : `${receiverText}.${name}`,
    receiver: () => spec.on ?? null,
    argumentCount: () => args.length,
    valueAt: (at: number) => args[at] ?? null,
    keywordAt: (keyword: string) => spec.keywords?.[keyword] ?? null,
    pairArgs: () =>
      (spec.pairs ?? []).map(([key, pairValue]) => ({
        key,
        value: pairValue,
      })),
    block: () =>
      spec.block === undefined ? null : value({ body: spec.block }),
    loopsOver: () => spec.loop ?? null,
  } as unknown as CallOps;
}

/** `<owner>.routes.<kind> do ... end` */
function root(owner: string, kind: string, ...entries: CallOps[]): CallOps {
  return call(kind, { on: call("routes", { onText: owner }), block: entries });
}

function module(...calls: CallOps[]): ModuleOps {
  return {
    calls: () => calls,
    bodyCalls: () => calls,
  } as unknown as ModuleOps;
}

const VERB = (method: string): ServesRole => ({
  role: "serves",
  methods: [method],
  path: [{ pair: "key" }, { at: 0 }],
  handler: [{ keyword: "to" }, { pair: "value" }],
  bare: {
    path: { at: 0 },
    action: { keyword: "action" },
    controller: { keyword: "controller" },
    on: { keyword: "on" },
    wordRule: { replace: ["-", "_"] },
  },
  formatless: { pick: { keyword: "format" }, when: false },
});

const PLURAL = {
  index: [{ method: "GET", suffix: "" }],
  show: [{ method: "GET", suffix: "{member}" }],
  update: [{ method: "update", suffix: "{member}" }],
};

const TABLE: RouteTableDeclaration = {
  roots: {
    calledOn: "routes",
    kinds: { prepend: 0, draw: 1, append: 2 },
    children: { in: "block" },
  },
  handler: { separator: "#", namespaceJoin: "/" },
  loops: ["each"],
  methodAliases: { update: ["PATCH", "PUT"] },
  roles: {
    get: VERB("GET"),
    post: VERB("POST"),
    match: { ...VERB(""), methods: { pick: { keyword: "via" }, all: "all" } },
    root: {
      role: "serves",
      methods: ["GET"],
      path: { fixed: "scope" },
      handler: [{ keyword: "to" }, { at: 0 }],
    },
    resources: {
      role: "expands",
      name: { at: 0 },
      rows: PLURAL,
      only: { keyword: "only" },
      except: { keyword: "except" },
      controller: { keyword: "controller" },
      path: { keyword: "path" },
      module: { keyword: "module" },
      concerns: { keyword: "concerns" },
      param: { keyword: "param" },
      shallow: { keyword: "shallow" },
      controllerNaming: "asWritten",
      nested: "singularId",
      member: "id",
      children: { in: "block" },
    },
    resource: {
      role: "expands",
      name: { at: 0 },
      rows: { show: [{ method: "GET", suffix: "" }] },
      shallow: { keyword: "shallow" },
      controllerNaming: "plural",
      nested: "self",
      member: "self",
      children: { in: "block" },
    },
    namespace: {
      role: "scopes",
      both: { at: 0 },
      shallowPath: true,
      children: { in: "block" },
    },
    scope: {
      role: "scopes",
      path: [{ keyword: "path" }, { at: 0 }],
      namespace: [{ keyword: "module" }],
      children: { in: "block" },
    },
    constraints: { role: "scopes", children: { in: "block" } },
    with_options: { role: "defaults", children: { in: "block" } },
    member: { role: "base", which: "member", children: { in: "block" } },
    collection: {
      role: "base",
      which: "collection",
      children: { in: "block" },
    },
    concern: { role: "fragment", name: { at: 0 }, children: { in: "block" } },
    concerns: { role: "replay", names: { from: 0 } },
    draw: { role: "include", name: { at: 0 } },
    mount: {
      role: "mount",
      table: [{ at: 0 }, { pair: "key" }],
      at: [{ keyword: "at" }, { pair: "value" }],
    },
  },
};

function sources(
  files: readonly ModuleOps[],
  more: Partial<RouteSources> = {},
): RouteSources {
  return {
    files: files.map((one, index) => ({
      module: one,
      displayPath: `routes${index}.rb`,
    })),
    ownerOf: (owner) =>
      owner === "Rails.application"
        ? { table: "app" }
        : owner === "Billing::Engine"
          ? { table: "mounted", name: owner, namespace: "billing" }
          : null,
    include: () => null,
    naming: {
      singular: (one) => one.replace(/s$/, ""),
      plural: (one) => `${one}s`,
    },
    ...more,
  };
}

function compose(...entries: CallOps[]) {
  return composeRoutes(
    TABLE,
    sources([module(root("Rails.application", "draw", ...entries))]),
  );
}

describe("composeRoutes", () => {
  it("serves an entry at the handler `to:` or a pair states, under the scope's namespace", () => {
    const set = compose(
      call("get", { args: [word("/x")], keywords: { to: word("a#b") } }),
      call("namespace", {
        args: [word("admin")],
        block: [
          call("post", { pairs: [[word("status"), word("health#show")]] }),
        ],
      }),
      call("get", { args: [word("/y")], keywords: { to: word("nohandler") } }),
    );
    expect(set.routesFor("a", "b")).toEqual([{ method: "GET", path: "/x" }]);
    expect(set.routesFor("admin/health", "show")).toEqual([
      { method: "POST", path: "/admin/status" },
    ]);
    expect(set.gaps).toEqual([]);
  });

  it("serves the methods a pick lists, and every method for `all`", () => {
    const set = compose(
      call("match", {
        args: [word("/m")],
        keywords: { to: word("m#a"), via: list(word("get"), word("post")) },
      }),
      call("match", {
        args: [word("/any")],
        keywords: { to: word("m#b"), via: word("all") },
      }),
    );
    expect(set.routesFor("m", "a").map((route) => route.method)).toEqual([
      "GET",
      "POST",
    ]);
    expect(set.routesFor("m", "b")).toEqual([{ method: "*", path: "/any" }]);
  });

  it("serves a root at the scope's own path", () => {
    const set = compose(
      call("root", { args: [word("home#index")] }),
      call("scope", {
        args: [word("v1")],
        block: [call("root", { keywords: { to: word("v1#home") } })],
      }),
    );
    expect(set.routesFor("home", "index")).toEqual([
      { method: "GET", path: "/" },
    ]);
    expect(set.routesFor("v1", "home")).toEqual([
      { method: "GET", path: "/v1" },
    ]);
  });

  it("expands an entry into its rows, with the aliases a method has and the filters it states", () => {
    const set = compose(
      call("resources", {
        args: [word("orders")],
        keywords: { except: list(word("index")) },
      }),
      call("resources", {
        args: [word("users")],
        keywords: {
          only: word("index"),
          controller: word("people"),
          path: word("members"),
          module: word("crm"),
        },
      }),
      call("resource", { args: [word("account")] }),
    );
    expect(set.routesFor("orders", "index")).toEqual([]);
    expect(set.routesFor("orders", "update")).toEqual([
      { method: "PATCH", path: "/orders/:id" },
      { method: "PUT", path: "/orders/:id" },
    ]);
    expect(set.routesFor("crm/people", "index")).toEqual([
      { method: "GET", path: "/members" },
    ]);
    expect(set.routesFor("accounts", "show")).toEqual([
      { method: "GET", path: "/account" },
    ]);
  });

  it("routes a bare entry inside an expansion to its controller, from the base `on` or a base block picks", () => {
    const set = compose(
      call("resources", {
        args: [word("orders")],
        block: [
          call("resources", {
            args: [word("items")],
            keywords: { only: list() },
          }),
          call("post", {
            args: [word("reset-score")],
            keywords: { on: word("member") },
          }),
          call("get", {
            args: [word("search")],
            keywords: { on: word("collection") },
          }),
          call("member", { block: [call("post", { args: [word("cancel")] })] }),
          call("collection", {
            block: [call("get", { args: [word("recent")] })],
          }),
          call("get", { args: [word("/a/b")] }),
          call("get", {
            args: [word("feed")],
            keywords: { format: flag(false) },
          }),
          call("get", {
            args: [word("start")],
            keywords: { action: word("begin") },
          }),
        ],
      }),
      call("member", { block: [call("post", { args: [word("orphan")] })] }),
      call("get", { args: [word("loose")] }),
    );
    expect(set.routesFor("orders", "reset_score")).toEqual([
      { method: "POST", path: "/orders/:id/reset-score" },
    ]);
    expect(set.routesFor("orders", "search")).toEqual([
      { method: "GET", path: "/orders/search" },
    ]);
    expect(set.routesFor("orders", "cancel")).toEqual([
      { method: "POST", path: "/orders/:id/cancel" },
    ]);
    expect(set.routesFor("orders", "recent")).toEqual([
      { method: "GET", path: "/orders/recent" },
    ]);
    expect(set.routesFor("orders", "feed")).toEqual([
      { method: "GET", path: "/orders/:order_id/feed", formatless: true },
    ]);
    expect(set.routesFor("orders", "begin")).toEqual([
      { method: "GET", path: "/orders/:order_id/start" },
    ]);
    expect(set.routesFor("orders", "/a/b")).toEqual([]);
    expect(set.routesFor("orders", "orphan")).toEqual([]);
    expect(set.routesFor("", "loose")).toEqual([]);
  });

  it("routes an entry with no handler and no action to the handler its path spells, when the role says its path names one", () => {
    const verb = VERB("GET");
    const spelled: RouteTableDeclaration = {
      ...TABLE,
      roles: {
        ...TABLE.roles,
        get: {
          ...verb,
          bare: {
            ...(verb.bare as NonNullable<ServesRole["bare"]>),
            handlerInPath: { optionalSuffix: "(.:format)" },
          },
        },
      },
    };
    const set = composeRoutes(
      spelled,
      sources([
        module(
          root(
            "Rails.application",
            "draw",
            call("get", { args: [word("/orders/refresh-totals")] }),
            call("get", { args: [word("daily/report(.:format)")] }),
            call("namespace", {
              args: [word("admin")],
              block: [call("get", { args: [word("audit/log-entries")] })],
            }),
            call("get", { args: [word("/orders/:id/print")] }),
            call("get", {
              args: [word("/orders/pending")],
              keywords: { action: word("index"), controller: word("orders") },
            }),
            call("get", {
              args: [word("/orders/archive")],
              keywords: { to: word("redirect") },
            }),
          ),
        ),
      ]),
    );
    expect(set.routesFor("orders", "refresh_totals")).toEqual([
      { method: "GET", path: "/orders/refresh-totals" },
    ]);
    expect(set.routesFor("daily", "report")).toEqual([
      { method: "GET", path: "/daily/report(.:format)" },
    ]);
    expect(set.routesFor("admin/audit", "log_entries")).toEqual([
      { method: "GET", path: "/admin/audit/log-entries" },
    ]);
    expect(set.routesFor("orders", "print")).toEqual([]);
    expect(set.routesFor("orders", "pending")).toEqual([]);
    expect(set.routesFor("orders", "index")).toEqual([
      { method: "GET", path: "/orders/pending" },
    ]);
    expect(set.routesFor("orders", "archive")).toEqual([]);
  });

  it("leaves an expansion for a scope that adds a segment, and keeps it for one that adds nothing", () => {
    const set = compose(
      call("resources", {
        args: [word("users")],
        keywords: { only: list() },
        block: [
          call("scope", {
            keywords: { module: word("users") },
            block: [
              call("resources", {
                args: [word("posts")],
                keywords: { only: list(word("index")) },
              }),
              call("get", { args: [word("bare")] }),
            ],
          }),
          call("constraints", {
            block: [call("get", { args: [word("kept")] })],
          }),
        ],
      }),
    );
    expect(set.routesFor("users/posts", "index")).toEqual([
      { method: "GET", path: "/users/:user_id/posts" },
    ]);
    expect(set.routesFor("users", "bare")).toEqual([]);
    expect(set.routesFor("users", "kept")).toEqual([
      { method: "GET", path: "/users/:user_id/kept" },
    ]);
  });

  it("hands a defaults entry's keywords to every entry inside it that leaves them out", () => {
    const set = compose(
      call("with_options", {
        keywords: { controller: word("pages") },
        block: [
          call("get", { args: [word("about")] }),
          call("get", {
            args: [word("help")],
            keywords: { controller: word("docs") },
          }),
        ],
      }),
    );
    expect(set.routesFor("pages", "about")).toEqual([
      { method: "GET", path: "/about" },
    ]);
    expect(set.routesFor("docs", "help")).toEqual([
      { method: "GET", path: "/help" },
    ]);
  });

  it("replays a fragment where a replay or an expansion's `concerns:` names it", () => {
    const set = compose(
      call("concern", {
        args: [word("commentable")],
        block: [
          call("resources", {
            args: [word("comments")],
            keywords: { only: list(word("index")) },
          }),
        ],
      }),
      call("resources", {
        args: [word("posts")],
        keywords: { only: list(), concerns: list(word("commentable")) },
      }),
      call("scope", {
        args: [word("v1")],
        block: [
          call("concerns", { args: [word("commentable"), word("missing")] }),
        ],
      }),
    );
    expect(set.routesFor("comments", "index")).toEqual([
      { method: "GET", path: "/posts/:post_id/comments" },
      { method: "GET", path: "/v1/comments" },
    ]);
  });

  it("includes another file's entries in place, once, and records a name with no file", () => {
    const admin = module(
      call("get", {
        args: [word("dash")],
        keywords: { to: word("admin#dash") },
      }),
      call("draw", { args: [word("admin")] }),
    );
    const set = composeRoutes(
      TABLE,
      sources(
        [
          module(
            root(
              "Rails.application",
              "draw",
              call("scope", {
                args: [word("x")],
                block: [call("draw", { args: [word("admin")] })],
              }),
              call("draw", { args: [word("gone")] }),
            ),
          ),
        ],
        { include: (name) => (name === "admin" ? admin : null) },
      ),
    );
    expect(set.routesFor("admin", "dash")).toEqual([
      { method: "GET", path: "/x/dash" },
    ]);
    expect(set.gaps).toEqual([
      { kind: "missingInclude", file: "routes0.rb", name: "gone" },
    ]);
  });

  it("mounts a table's first root under a prefix and its own namespace, and records any other mount", () => {
    const engine = module(
      root(
        "Billing::Engine",
        "draw",
        call("get", {
          args: [word("invoices")],
          keywords: { to: word("invoices#index") },
        }),
        call("mount", {
          args: [word("Billing::Engine")],
          keywords: { at: word("/again") },
        }),
      ),
      root(
        "Billing::Engine",
        "append",
        call("get", { args: [word("later")], keywords: { to: word("x#y") } }),
      ),
    );
    const app = module(
      root(
        "Rails.application",
        "draw",
        call("namespace", {
          args: [word("admin")],
          block: [
            call("mount", {
              pairs: [[word("Billing::Engine"), word("/billing")]],
            }),
          ],
        }),
        call("mount", { pairs: [[word("Sidekiq::Web"), word("/sidekiq")]] }),
      ),
      root(
        "Other::Thing",
        "draw",
        call("get", { args: [word("no")], keywords: { to: word("no#no") } }),
      ),
    );
    const set = composeRoutes(TABLE, sources([app, engine]));
    expect(set.routesFor("billing/invoices", "index")).toEqual([
      { method: "GET", path: "/admin/billing/invoices" },
    ]);
    expect(set.routesFor("billing/x", "y")).toEqual([]);
    expect(set.routesFor("no", "no")).toEqual([]);
    expect(set.gaps).toEqual([
      { kind: "unread", file: "routes1.rb", name: "mount" },
      { kind: "unread", file: "routes0.rb", name: "mount" },
    ]);
  });

  it("replays a listed loop over a literal list once per element, and skips any other call on a receiver", () => {
    const loopOver = (method: string, items: ValueOps[]) =>
      call(method, {
        onText: "%w[a b]",
        loop: { over: list(...items), element: "name", position: "i" },
        block: [
          call("get", {
            args: [ref("name")],
            keywords: { to: word("letters#show") },
          }),
        ],
      });
    const set = compose(
      loopOver("each", [word("a"), ref("unbound"), word("b")]),
      loopOver("map", [word("c")]),
      call("each", {
        onText: "items",
        block: [call("get", { args: [word("d")] })],
      }),
    );
    expect(set.routesFor("letters", "show")).toEqual([
      { method: "GET", path: "/a" },
      { method: "GET", path: "/b" },
    ]);
    expect(set.gaps).toEqual([]);
  });

  it("walks a library's wrapper with entries inside in place, and records any other call it does not know", () => {
    const set = compose(
      call("devise_scope", {
        args: [word("user")],
        block: [
          call("get", {
            args: [word("/in")],
            keywords: { to: word("sessions#new") },
          }),
        ],
      }),
      call("direct", { args: [word("home")], block: [call("url_for")] }),
    );
    expect(set.routesFor("sessions", "new")).toEqual([
      { method: "GET", path: "/in" },
    ]);
    expect(set.gaps).toEqual([
      { kind: "walkedBlock", file: "routes0.rb", name: "devise_scope" },
      { kind: "unread", file: "routes0.rb", name: "direct" },
    ]);
  });

  it("runs the app's roots in the order their kinds give, and finds one inside another call's block", () => {
    const at = (path: string) =>
      call("get", { args: [word(path)], keywords: { to: word("all#one") } });
    const set = composeRoutes(
      TABLE,
      sources([
        module(
          root("Rails.application", "append", at("/appended")),
          root("Rails.application", "draw", at("/drawn")),
        ),
        module(
          call("after_initialize", {
            block: [root("Rails.application", "prepend", at("/prepended"))],
          }),
        ),
      ]),
    );
    expect(set.routesFor("all", "one").map((route) => route.path)).toEqual([
      "/prepended",
      "/drawn",
      "/appended",
    ]);
  });

  it("reads children handed as a callback or written as a list of calls", () => {
    const bareTable: RouteTableDeclaration = {
      ...TABLE,
      roots: { kinds: { routes: 0 }, children: { in: "callback", at: 0 } },
      roles: {
        get: { ...VERB("GET"), path: [{ at: 0 }], handler: [{ at: 1 }] },
        scope: {
          role: "scopes",
          path: [{ at: 0 }],
          children: { in: "list", pick: { at: 1 } },
        },
      },
    };
    const inner = call("get", { args: [word("/x"), word("a#b")] });
    const scoped = call("scope", {
      args: [word("/api"), list(value({ call: inner }), word("skipped"))],
    });
    const routes = call("routes", { args: [value({ body: [scoped] })] });
    const set = composeRoutes(bareTable, {
      ...sources([module(routes)]),
      ownerOf: (owner) => (owner === "" ? { table: "app" } : null),
    });
    expect(set.routesFor("a", "b")).toEqual([
      { method: "GET", path: "/api/x" },
    ]);
  });

  it("names the member segment and the nesting parameter after `param`", () => {
    const set = compose(
      call("resources", {
        args: [word("accounts")],
        keywords: { param: word("username"), only: list(word("show")) },
        block: [
          call("resources", {
            args: [word("posts")],
            keywords: { only: list(word("index")) },
          }),
        ],
      }),
    );
    expect(set.routesFor("accounts", "show")).toEqual([
      { method: "GET", path: "/accounts/:username" },
    ]);
    expect(set.routesFor("posts", "index")).toEqual([
      { method: "GET", path: "/accounts/:account_username/posts" },
    ]);
  });

  it("serves a shallow expansion's member routes, and what nests inside it, from the shallow path", () => {
    const set = compose(
      call("namespace", {
        args: [word("admin")],
        block: [
          call("scope", {
            args: [word("v1")],
            block: [
              call("resources", {
                args: [word("projects")],
                keywords: { shallow: flag(true), only: list() },
                block: [
                  call("resources", {
                    args: [word("sections")],
                    keywords: { only: list(word("index"), word("show")) },
                    block: [
                      call("resources", {
                        args: [word("tags")],
                        keywords: { only: list(word("index")) },
                      }),
                      call("resource", { args: [word("cover")] }),
                    ],
                  }),
                ],
              }),
            ],
          }),
        ],
      }),
    );
    expect(set.routesFor("admin/sections", "index")).toEqual([
      { method: "GET", path: "/admin/projects/:project_id/sections" },
    ]);
    expect(set.routesFor("admin/sections", "show")).toEqual([
      { method: "GET", path: "/admin/sections/:id" },
    ]);
    expect(set.routesFor("admin/tags", "index")).toEqual([
      { method: "GET", path: "/admin/sections/:section_id/tags" },
    ]);
    expect(set.routesFor("admin/covers", "show")).toEqual([
      { method: "GET", path: "/admin/sections/:section_id/cover" },
    ]);
  });

  it("reads nothing from an entry missing what its role needs, or written where the table has no reader", () => {
    const table: RouteTableDeclaration = {
      ...TABLE,
      roles: {
        ...TABLE.roles,
        head: {
          role: "serves",
          methods: ["HEAD"],
          path: [{ at: 0 }],
          handler: [{ key: "to" }],
        },
        chained: {
          role: "scopes",
          path: [{ at: 0 }],
          children: { in: "chain" },
        },
      },
    };
    const set = composeRoutes(
      table,
      sources([
        module(
          root(
            "Rails.application",
            "draw",
            call("head", { args: [word("/h")] }),
            call("chained", {
              args: [word("c")],
              block: [
                call("get", {
                  args: [word("/x")],
                  keywords: { to: word("c#x") },
                }),
              ],
            }),
            call("resources"),
            call("scope", { args: [word("s")] }),
            call("mount"),
            call("mount", {
              args: [word("Billing::Engine")],
              keywords: { at: word("/b") },
            }),
          ),
          call("draw", {
            onText: "Rails.application",
            block: [
              call("get", {
                args: [word("/no")],
                keywords: { to: word("c#no") },
              }),
            ],
          }),
        ),
      ]),
    );
    expect(set.routesFor("c", "x")).toEqual([]);
    expect(set.routesFor("c", "no")).toEqual([]);
    expect(set.gaps).toEqual([
      { kind: "unread", file: "routes0.rb", name: "mount" },
    ]);
  });
});

describe("joinRoutePath", () => {
  it("joins with one slash between, and gives the prefix or `/` for a segment that is nothing", () => {
    expect(joinRoutePath("", "")).toBe("/");
    expect(joinRoutePath("", "/")).toBe("/");
    expect(joinRoutePath("/a/", "/")).toBe("/a");
    expect(joinRoutePath("/a", "b/")).toBe("/a/b");
  });

  it("agrees with the mount join on a segment written with its leading slash", () => {
    for (const [prefix, segment] of [
      ["", "x"],
      ["/v1", "/orders"],
      ["/v1/", "orders/"],
      ["/", "health"],
    ] as const) {
      const trimmed = segment.replace(/^\/+|\/+$/g, "");
      expect(joinRoutePath(prefix, segment)).toBe(
        joinMountedPath(prefix.replace(/\/+$/, ""), `/${trimmed}`),
      );
    }
  });
});
