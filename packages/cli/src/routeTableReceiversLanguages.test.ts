/**
 * One route table whose entries are made on a value, read from the same
 * app written in Python and TypeScript. Python decorates functions and a
 * class and mounts with a keyword, and TypeScript decorates methods and a
 * class and mounts with the path first. Both mount a router twice, leave
 * one unmounted, and mount two from a loop over a list, so the composer
 * reads every one through the module ops each adapter states.
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
import { moduleOpsFor, ResolutionStore } from "@suss/adapter-typescript";
import { composeRoutes } from "@suss/recognize";
import { createTestProject } from "@suss/test-project";

import type { ModuleOps } from "@suss/extractor";
import type {
  RouteOutcome,
  RouteTableDeclaration,
  ServesRole,
} from "@suss/recognize";

const GET: ServesRole = {
  role: "serves",
  methods: ["GET"],
  path: [{ at: 0 }],
  handler: { decorated: true },
};

const ROUTE: ServesRole = {
  role: "serves",
  methods: { members: ["get", "post"] },
  path: [{ at: 0 }],
  handler: { decorated: true },
};

const PYTHON_TABLE: RouteTableDeclaration = {
  roots: {
    kinds: { App: 0 },
    children: { in: "receiver" },
    in: "file",
    unlessDropped: { owned: [] },
  },
  from: ["lib"],
  joins: "asWritten",
  loops: ["for"],
  roles: {
    get: GET,
    route: ROUTE,
    include: {
      role: "mount",
      table: [{ at: 0 }],
      at: [{ keyword: "prefix" }],
      prefix: "inFront",
    },
    Router: {
      role: "scopes",
      path: [{ keyword: "prefix" }],
      children: { in: "receiver" },
      noValue: "unreadable",
    },
  },
};

const TYPESCRIPT_TABLE: RouteTableDeclaration = {
  ...PYTHON_TABLE,
  roles: {
    get: GET,
    route: ROUTE,
    use: {
      role: "mount",
      table: [{ at: 1 }],
      at: [{ at: 0 }],
      prefix: "inFront",
    },
    Router: {
      role: "scopes",
      path: [{ at: 0 }],
      children: { in: "receiver" },
      noValue: "unreadable",
    },
  },
};

const PYTHON = `
from lib import App, Router

app = App()
items = Router(prefix="/items")
orphan = Router(prefix="/orphan")
a = Router(prefix="/a")
b = Router(prefix="/b")

@app.get("/health")
def health():
    return "ok"

@items.get("/{id}")
def item(id):
    return id

@orphan.get("/x")
def lost():
    return None

@a.get("/x")
def in_a():
    return None

@b.get("/y")
def in_b():
    return None

@app.route("/things")
class Things:
    def get(self):
        return []

    def post(self):
        return {}

app.include(items, prefix="/api")
app.include(items, prefix="/v2")
for r in [a, b]:
    app.include(r)

def build():
    local = App()

    @local.get("/gone")
    def gone():
        return None
`;

const TYPESCRIPT = `
import { App, Router } from "lib";

const app = App();
const items = Router("/items");
const orphan = Router("/orphan");
const a = Router("/a");
const b = Router("/b");

class Handlers {
  @app.get("/health")
  health() {
    return "ok";
  }

  @items.get("/{id}")
  item() {
    return null;
  }

  @orphan.get("/x")
  lost() {
    return null;
  }

  @a.get("/x")
  inA() {
    return null;
  }

  @b.get("/y")
  inB() {
    return null;
  }
}

@app.route("/things")
class Things {
  get() {
    return [];
  }

  post() {
    return {};
  }
}

app.use("/api", items);
app.use("/v2", items);
for (const r of [a, b]) {
  app.use("", r);
}
`;

let root: string;

beforeAll(() => {
  root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "suss-route-receivers-")),
  );
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

async function pythonModule(): Promise<ModuleOps> {
  const file = path.join(root, "main.py");
  const tree = await parsePython(PYTHON);
  const module = bindModule(tree.rootNode);
  const db = pythonFactsForFile({
    file,
    root: tree.rootNode,
    module,
    packs: [],
  });
  return pythonModuleOps(
    { file, displayPath: "main.py", root: tree.rootNode, module },
    db,
  );
}

function typescriptModule(): ModuleOps {
  const project = createTestProject();
  const file = project.createSourceFile("/main.ts", TYPESCRIPT);
  return moduleOpsFor(file, ResolutionStore.forPacks([]));
}

function outcomesOf(
  module: ModuleOps,
  table: RouteTableDeclaration,
): readonly RouteOutcome[] {
  return composeRoutes(table, {
    files: [{ module, displayPath: module.path() }],
    ownerOf: () => ({ table: "app" }),
    include: () => null,
    naming: { singular: (word) => word, plural: (word) => word },
  }).outcomes;
}

/**
 * Each outcome by its method and path, or its reason, and the name its
 * handler is declared under. A TypeScript method's text starts with its
 * decorators, so the first line that is no decorator gives the name.
 */
function said(outcomes: readonly RouteOutcome[]): string[] {
  return outcomes.map((outcome) => {
    const written = "handler" in outcome ? outcome.handler.source?.() : "";
    const declared = (written ?? "")
      .split("\n")
      .map((line) => line.trim())
      .find((line) => !line.startsWith("@"));
    const name = /^(?:async\s+)?(?:def\s+)?(\w+)/.exec(declared ?? "")?.[1];
    return outcome.kind === "route"
      ? `${outcome.method} ${outcome.path} ${name}`
      : `${outcome.reason} ${name}`;
  });
}

describe("a route table whose entries are made on a value, read from two languages", () => {
  it("serves the decorated functions and class methods, a router mounted twice and two a loop mounts, and says the unmounted one is unreached, in Python", async () => {
    expect(said(outcomesOf(await pythonModule(), PYTHON_TABLE))).toEqual([
      "GET /health health",
      "GET /things get",
      "POST /things post",
      "GET /api/items/{id} item",
      "GET /v2/items/{id} item",
      "GET /a/x in_a",
      "GET /b/y in_b",
      "unreached lost",
    ]);
  });

  it("serves the decorated methods and class methods, a router mounted twice and two a loop mounts, and says the unmounted one is unreached, in TypeScript", () => {
    expect(said(outcomesOf(typescriptModule(), TYPESCRIPT_TABLE))).toEqual([
      "GET /health health",
      "GET /things get",
      "POST /things post",
      "GET /api/items/{id} item",
      "GET /v2/items/{id} item",
      "GET /a/x inA",
      "GET /b/y inB",
      "unreached lost",
    ]);
  });
});
