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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "module-mount-"));
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

const ordersModule = [
  "from fastapi import APIRouter",
  "",
  'router = APIRouter(prefix="/orders")',
  "",
  "",
  '@router.get("/{order_id}")',
  "def read_order(order_id: int):",
  "    pass",
  "",
].join("\n");

describe("a mount written through the module that defines the router", () => {
  it("follows `orders.router` to the construction in the orders module", async () => {
    const summaries = await summariesOf({
      "orders.py": ordersModule,
      "main.py": [
        "from fastapi import FastAPI",
        "import orders",
        "",
        "app = FastAPI()",
        'app.include_router(orders.router, prefix="/api")',
        "",
      ].join("\n"),
    });
    expect(pathOf(summaries, "read_order")).toBe("/api/orders/{order_id}");
  });

  it("follows a module brought in with `from pkg import orders`", async () => {
    const summaries = await summariesOf({
      "pkg/__init__.py": "",
      "pkg/orders.py": ordersModule,
      "main.py": [
        "from fastapi import FastAPI",
        "from pkg import orders",
        "",
        "app = FastAPI()",
        'app.include_router(orders.router, prefix="/api")',
        "",
      ].join("\n"),
    });
    expect(pathOf(summaries, "read_order")).toBe("/api/orders/{order_id}");
  });

  it("follows the same mount written inside an app factory", async () => {
    const summaries = await summariesOf({
      "orders.py": ordersModule,
      "main.py": [
        "from fastapi import FastAPI",
        "import orders",
        "",
        "",
        "def create_app():",
        "    app = FastAPI()",
        '    app.include_router(orders.router, prefix="/api")',
        "    return app",
        "",
      ].join("\n"),
    });
    expect(pathOf(summaries, "read_order")).toBe("/api/orders/{order_id}");
  });

  it("leaves a two-hop attribute unread rather than guessing", async () => {
    const summaries = await summariesOf({
      "pkg/__init__.py": "",
      "pkg/orders.py": ordersModule,
      "main.py": [
        "from fastapi import FastAPI",
        "import pkg",
        "",
        "app = FastAPI()",
        'app.include_router(pkg.orders.router, prefix="/api")',
        "",
      ].join("\n"),
    });
    expect(pathOf(summaries, "read_order")).toBeNull();
  });

  it("says nothing for an attribute on a name nothing declares", async () => {
    const summaries = await summariesOf({
      "orders.py": ordersModule,
      "main.py": [
        "from fastapi import FastAPI",
        "",
        "app = FastAPI()",
        'app.include_router(missing.router, prefix="/api")',
        "",
      ].join("\n"),
    });
    expect(pathOf(summaries, "read_order")).toBeNull();
  });

  it("says nothing when the module is imported and its file is not in the run", async () => {
    const summaries = await summariesOf({
      "orders.py": ordersModule,
      "main.py": [
        "from fastapi import FastAPI",
        "import vendor_routes",
        "",
        "app = FastAPI()",
        'app.include_router(vendor_routes.router, prefix="/api")',
        "",
      ].join("\n"),
    });
    expect(pathOf(summaries, "read_order")).toBeNull();
  });

  it("says nothing for an attribute on a name that is not a module", async () => {
    const summaries = await summariesOf({
      "orders.py": ordersModule,
      "main.py": [
        "from fastapi import FastAPI",
        "",
        "app = FastAPI()",
        "holder = object()",
        'app.include_router(holder.router, prefix="/api")',
        "",
      ].join("\n"),
    });
    expect(pathOf(summaries, "read_order")).toBeNull();
  });
});
