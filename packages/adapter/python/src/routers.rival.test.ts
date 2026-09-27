import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { extractPythonProject, findPythonFiles } from "./index.js";

import type { PythonPack } from "./pack.js";

/** A fastapi-shaped pack, written here rather than imported, because an adapter does not depend on a pack. */
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

async function summariesOf(files: Record<string, string>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rival-"));
  for (const [name, source] of Object.entries(files)) {
    const full = path.join(dir, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, source);
  }
  const { summaries } = await extractPythonProject({
    files: findPythonFiles(dir),
    packs: [fastapiLike],
    roots: [dir],
    workspaceRoot: dir,
  });
  return summaries;
}

function pathOf(
  summaries: Awaited<ReturnType<typeof summariesOf>>,
  name: string,
) {
  const summary = summaries.find((s) => s.identity.name === name);
  const semantics = summary?.identity.boundaryBinding?.semantics;
  return semantics?.name === "rest" ? semantics.path : undefined;
}

function gapTextOf(
  summaries: Awaited<ReturnType<typeof summariesOf>>,
  name: string,
) {
  const summary = summaries.find((s) => s.identity.name === name);
  return (summary?.gaps ?? []).map((entry) => entry.description).join(" ");
}

const usersModule = [
  "from fastapi import FastAPI, APIRouter",
  "",
  'router = APIRouter(prefix="/users")',
  "",
  "",
  '@router.get("/{user_id}")',
  "def read_user(user_id: int):",
  "    pass",
  "",
  "",
  "def create_app():",
  "    app = FastAPI()",
  '    app.include_router(router, prefix="/api")',
  "    return app",
  "",
].join("\n");

const loaderApp = [
  "from fastapi import FastAPI",
  "import loader",
  "",
  "",
  "def create_plugin_app():",
  "    app = FastAPI()",
  "    for mounted in loader.load_routers():",
  "        app.include_router(mounted)",
  "    return app",
  "",
].join("\n");

describe("how far a loop this reading cannot enumerate reaches", () => {
  it("keeps a function-site mount when the loop is in a sibling package", async () => {
    const summaries = await summariesOf({
      "api/__init__.py": "",
      "api/users.py": usersModule,
      "plugins/__init__.py": "",
      "plugins/app.py": loaderApp,
    });
    expect(pathOf(summaries, "read_user")).toBe("/api/users/{user_id}");
  });

  it("counts the loop as a rival when its file's directory contains the router's file", async () => {
    const summaries = await summariesOf({
      "api/__init__.py": "",
      "api/users.py": usersModule,
      "app.py": loaderApp,
    });
    expect(pathOf(summaries, "read_user")).toBeNull();
    expect(gapTextOf(summaries, "read_user")).toContain(
      "mounts routers this reading cannot name",
    );
  });

  it("does not blame a sibling package's loop for a router nothing mounts", async () => {
    const summaries = await summariesOf({
      "api/__init__.py": "",
      "api/extra.py": [
        "from fastapi import APIRouter",
        "",
        'router = APIRouter(prefix="/extra")',
        "",
        "",
        '@router.get("/")',
        "def read_extra():",
        "    pass",
        "",
      ].join("\n"),
      "plugins/__init__.py": "",
      "plugins/app.py": loaderApp,
    });
    expect(gapTextOf(summaries, "read_extra")).toContain(
      "is never mounted through a single variable binding",
    );
  });

  it("still points an unmounted router at a loop whose directory contains it", async () => {
    const summaries = await summariesOf({
      "api/__init__.py": "",
      "api/extra.py": [
        "from fastapi import APIRouter",
        "",
        'router = APIRouter(prefix="/extra")',
        "",
        "",
        '@router.get("/")',
        "def read_extra():",
        "    pass",
        "",
      ].join("\n"),
      "app.py": loaderApp,
    });
    expect(gapTextOf(summaries, "read_extra")).toContain(
      "routers read out of a call this reading does not follow",
    );
  });
});

function pathsOf(
  summaries: Awaited<ReturnType<typeof summariesOf>>,
  name: string,
): (string | null | undefined)[] {
  return summaries
    .filter((s) => s.identity.name === name)
    .map((s) => {
      const semantics = s.identity.boundaryBinding?.semantics;
      return semantics?.name === "rest" ? semantics.path : undefined;
    });
}

/** A second app built in a function, mounting the served app's router under a prefix of its own. */
function itemsModule(testAppBody: string[]): string {
  return [
    "from fastapi import APIRouter, FastAPI",
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
    "",
    "def build_test_app(holder, apps):",
    "    test_app = FastAPI()",
    '    test_app.include_router(router, prefix="/t")',
    ...testAppBody,
    "",
  ].join("\n");
}

describe("a mount on an app that never leaves the function that built it", () => {
  it("claims only the path the served app mounts", async () => {
    const summaries = await summariesOf({ "main.py": itemsModule([]) });
    expect(pathsOf(summaries, "read_item")).toEqual(["/items/{item_id}"]);
  });

  it("keeps the mount when the function returns the app", async () => {
    const summaries = await summariesOf({
      "main.py": itemsModule(["    return test_app"]),
    });
    expect(pathsOf(summaries, "read_item").sort()).toEqual([
      "/items/{item_id}",
      "/t/items/{item_id}",
    ]);
  });

  it.each([
    ["hands the app to a call", "    serve(test_app)"],
    ["yields the app", "    yield test_app"],
    ["returns the app in parentheses", "    return (test_app)"],
    [
      "returns the app from a conditional",
      "    return test_app if ready else None",
    ],
    ["returns a lambda that gives the app back", "    return lambda: test_app"],
    [
      "writes the app to a second name",
      "    served = test_app\n    return served",
    ],
    ["returns a property of the app", "    return test_app.router"],
    ["stores the app on a parameter", "    holder.app = test_app"],
    ["stores the app under a key", '    apps["t"] = test_app'],
    ["enters the app with `with`", "    with test_app:\n        pass"],
    [
      "enters the app with `with` under a name",
      "    with test_app as entered:\n        pass",
    ],
    ["returns the app in a tuple", "    return test_app, holder"],
    [
      "returns the app from a comprehension",
      "    return [test_app for _ in apps]",
    ],
    ["returns the app under a computed key", "    return {holder: test_app}"],
    [
      "gives the app to a nested def as a default",
      "    def served(app=test_app):\n        return app\n    return served",
    ],
    ["runs a method the pack does not register with", "    test_app.run()"],
    ["calls the app itself", "    test_app(scope, receive, send)"],
    [
      "writes the app to a parameter's property twice",
      "    holder.app = test_app\n    holder.app = None",
    ],
    [
      "returns a closure that gives the app back",
      "    def served():\n        return test_app\n    return served",
    ],
    ["hands a property of the app to a call", "    serve(test_app.router)"],
  ])("keeps the mount when the function %s", async (_, body) => {
    const summaries = await summariesOf({ "main.py": itemsModule([body]) });
    expect(pathsOf(summaries, "read_item").sort()).toEqual([
      "/items/{item_id}",
      "/t/items/{item_id}",
    ]);
  });

  it.each([
    [
      "registers a route of its own on the app",
      '    @test_app.get("/health")\n    def health():\n        pass',
    ],
    ["writes to a part of the app", "    test_app.state.ready = True"],
    [
      "mounts twice on the app",
      '    test_app.include_router(router, prefix="/u")',
    ],
  ])("drops the mount when the function %s", async (_, body) => {
    const summaries = await summariesOf({ "main.py": itemsModule([body]) });
    expect(pathsOf(summaries, "read_item")).toEqual(["/items/{item_id}"]);
  });
});
