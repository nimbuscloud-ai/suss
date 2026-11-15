/**
 * One route table, written with blocks in Ruby, with callbacks in
 * TypeScript and with lists in Python. The composer reads only the module
 * ops each adapter states over its own facts, so the three have to give
 * the same routes.
 *
 * The loop is read in Ruby alone. Python writes no loop as a call, and
 * the TypeScript adapter states no element for a loop inside a callback
 * handed to a call at the top of a file.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  bindModule,
  parsePython,
  factsForFile as pythonFactsForFile,
  pythonModuleOps,
} from "@suss/adapter-python";
import { moduleOpsForFile, preloadRubyGrammar } from "@suss/adapter-ruby";
import { moduleOpsFor, ResolutionStore } from "@suss/adapter-typescript";
import { composeRoutes } from "@suss/recognize";
import { createTestProject } from "@suss/test-project";

import type { ModuleOps } from "@suss/extractor";
import type {
  ChildrenIn,
  RouteSet,
  RouteTableDeclaration,
} from "@suss/recognize";

const TYPESCRIPT = `
routes(() => {
  get("/health", "status#show");
  concern("commentable", () => {
    post("comments", "comments#create");
  });
  scope("/api", () => {
    get("/x", "a#b");
    resources("orders", () => {
      concerns("commentable");
    });
  });
});
`;

const PYTHON = `
routes([
    get("/health", "status#show"),
    concern("commentable", [post("comments", "comments#create")]),
    scope("/api", [
        get("/x", "a#b"),
        resources("orders", [concerns("commentable")]),
    ]),
])
`;

const RUBY = `
routes do
  get "/health", "status#show"
  concern :commentable do
    post "comments", "comments#create"
  end
  scope "/api" do
    get "/x", "a#b"
    resources :orders do
      concerns :commentable
    end
  end
end
`;

const RUBY_LOOPS = `
routes do
  %w[a b].each do |name|
    get name, "letters#show"
  end
  %w[c].map do |name|
    get name, "letters#show"
  end
end
`;

/** The table, with its entries' children written where the language writes them, given the argument they follow. */
function table(
  children: (after: number) => ChildrenIn,
  loops: readonly string[] = [],
): RouteTableDeclaration {
  const serves = (method: string) =>
    ({
      role: "serves",
      methods: [method],
      path: [{ at: 0 }],
      handler: [{ at: 1 }],
    }) as const;
  return {
    roots: { kinds: { routes: 0 }, children: children(0) },
    handler: { separator: "#", namespaceJoin: "/" },
    loops,
    roles: {
      get: serves("GET"),
      post: serves("POST"),
      scope: { role: "scopes", path: [{ at: 0 }], children: children(1) },
      resources: {
        role: "expands",
        name: { at: 0 },
        rows: {
          index: [{ method: "GET", suffix: "" }],
          show: [{ method: "GET", suffix: "{member}" }],
        },
        controllerNaming: "asWritten",
        nested: "singularId",
        member: "id",
        children: children(1),
      },
      concern: { role: "fragment", name: { at: 0 }, children: children(1) },
      concerns: { role: "replay", names: { from: 0 } },
    },
  };
}

const IN_BLOCK = (): ChildrenIn => ({ in: "block" });
const IN_CALLBACK = (after: number): ChildrenIn => ({
  in: "callback",
  at: after,
});
const IN_LIST = (after: number): ChildrenIn => ({
  in: "list",
  pick: { at: after },
});

function compose(
  module: ModuleOps,
  declaration: RouteTableDeclaration,
): RouteSet {
  return composeRoutes(declaration, {
    files: [{ module, displayPath: "routes" }],
    ownerOf: (owner) => (owner === "" ? { table: "app" } : null),
    include: () => null,
    naming: {
      singular: (word) => word.replace(/s$/, ""),
      plural: (word) => `${word}s`,
    },
  });
}

/** Every route the set gives the actions the table above serves. */
function served(set: RouteSet) {
  return Object.fromEntries(
    [
      ["status", "show"],
      ["a", "b"],
      ["orders", "index"],
      ["orders", "show"],
      ["comments", "create"],
      ["letters", "show"],
    ].map(([controller, action]) => [
      `${controller}#${action}`,
      set.routesFor(controller ?? "", action ?? ""),
    ]),
  );
}

let root: string;

beforeAll(async () => {
  await preloadRubyGrammar();
  root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "suss-route-table-")),
  );
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function typescriptModule(source: string): ModuleOps {
  const project = createTestProject();
  const file = project.createSourceFile("/routes.ts", source);
  return moduleOpsFor(file, ResolutionStore.forPacks([]));
}

async function pythonModule(source: string): Promise<ModuleOps> {
  const file = path.join(root, "routes.py");
  const tree = await parsePython(source);
  const module = bindModule(tree.rootNode);
  const db = pythonFactsForFile({
    file,
    root: tree.rootNode,
    module,
    packs: [],
  });
  return pythonModuleOps(
    { file, displayPath: "routes.py", root: tree.rootNode, module },
    db,
  );
}

function rubyModule(source: string, name: string): ModuleOps {
  const file = path.join(root, name);
  fs.writeFileSync(file, source);
  return moduleOpsForFile(file);
}

describe("one route table written in three languages", () => {
  it("gives the same routes from blocks, callbacks and lists", async () => {
    const expected = {
      "status#show": [{ method: "GET", path: "/health" }],
      "a#b": [{ method: "GET", path: "/api/x" }],
      "orders#index": [{ method: "GET", path: "/api/orders" }],
      "orders#show": [{ method: "GET", path: "/api/orders/:id" }],
      "comments#create": [
        { method: "POST", path: "/api/orders/:order_id/comments" },
      ],
      "letters#show": [],
    };
    expect(
      served(compose(rubyModule(RUBY, "routes.rb"), table(IN_BLOCK))),
    ).toEqual(expected);
    expect(
      served(compose(typescriptModule(TYPESCRIPT), table(IN_CALLBACK))),
    ).toEqual(expected);
    expect(served(compose(await pythonModule(PYTHON), table(IN_LIST)))).toEqual(
      expected,
    );
  });

  it("replays a loop over a literal list once per element, and a `map` only when the table lists it", () => {
    const module = rubyModule(RUBY_LOOPS, "loops.rb");
    const paths = (loops: readonly string[]) =>
      compose(module, table(IN_BLOCK, loops))
        .routesFor("letters", "show")
        .map((route) => route.path);
    expect(paths(["each"])).toEqual(["/a", "/b"]);
    expect(paths(["each", "map"])).toEqual(["/a", "/b", "/c"]);
  });
});

/** A table whose entries are objects in a list, each handing over a value as its handler. */
const OBJECTS: RouteTableDeclaration = {
  roots: { kinds: { routes: 0 }, children: { in: "list", pick: { at: 0 } } },
  roles: {
    entry: {
      role: "serves",
      methods: ["GET"],
      path: [{ key: "path" }],
      index: { key: "index" },
      handler: { value: [{ key: "handler" }] },
      children: [{ in: "list", pick: { key: "children" } }],
    },
  },
  objects: "entry",
  loops: [],
};

const OBJECTS_TYPESCRIPT = `
const nested = [{ path: "b", handler: h2 }, { index: true, handler: h3 }];
routes([
  { path: "/a", handler: h1, children: nested },
  { path: base, handler: h4, children: [{ path: "c", handler: h5 }] },
  ...more,
  make(),
]);
`;

const OBJECTS_PYTHON = `
nested = [{"path": "b", "handler": h2}, {"index": True, "handler": h3}]
routes([
    {"path": "/a", "handler": h1, "children": nested},
    {"path": base, "handler": h4, "children": [{"path": "c", "handler": h5}]},
    *more,
    make(),
])
`;

const OBJECTS_RUBY = `
nested = [{ path: "b", handler: h2 }, { index: true, handler: h3 }]
routes([
  { path: "/a", handler: h1, children: nested },
  { path: base, handler: h4, children: [{ path: "c", handler: h5 }] },
  *more,
  make(),
])
`;

/** Each outcome, with a value by its source text. */
function outcomes(set: RouteSet): string[] {
  return set.outcomes.map((outcome) => {
    if (outcome.kind === "route") {
      return `${outcome.method} ${outcome.path} ${outcome.handler.source?.()}`;
    }
    return "handler" in outcome
      ? `${outcome.reason} ${outcome.handler.source?.()}`
      : `${outcome.reason} ${outcome.value.source?.()}`;
  });
}

describe("one table of objects written in three languages", () => {
  it("gives the same routes, and says the same entries did not read", async () => {
    const expected = [
      "GET /a h1",
      "GET /a/b h2",
      "GET /a h3",
      "pathUnread h4",
      "prefixUnread h5",
      "spread more",
      "notAnEntry make()",
    ];
    expect(
      outcomes(compose(typescriptModule(OBJECTS_TYPESCRIPT), OBJECTS)),
    ).toEqual(expected);
    expect(
      outcomes(compose(await pythonModule(OBJECTS_PYTHON), OBJECTS)),
    ).toEqual(expected);
    expect(
      outcomes(compose(rubyModule(OBJECTS_RUBY, "objects.rb"), OBJECTS)),
    ).toEqual(expected);
  });
});
