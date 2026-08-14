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
