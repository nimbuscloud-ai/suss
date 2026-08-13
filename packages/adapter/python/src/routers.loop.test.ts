import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { extractPythonProject, findPythonFiles } from "./index.js";

import type { PythonPack } from "./pack.js";

/**
 * A flask-restx shaped pack, written here rather than imported, because an
 * adapter does not depend on a pack.
 */
const flaskRestxLike: PythonPack = {
  name: "flask-restx",
  protocol: "http",
  discovery: [
    {
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

/** A project on disk, since a loop over a call is settled across files. */
async function pathsOf(files: Record<string, string>): Promise<string[]> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loop-"));
  for (const [name, source] of Object.entries(files)) {
    const full = path.join(dir, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, source);
  }
  const { summaries } = await extractPythonProject({
    files: findPythonFiles(dir),
    packs: [flaskRestxLike],
    roots: [dir],
    workspaceRoot: dir,
  });
  return summaries
    .map((summary) => summary.identity.boundaryBinding?.semantics)
    .map((semantics) =>
      semantics !== undefined && semantics.name === "rest"
        ? semantics.path
        : null,
    )
    .filter((servedPath): servedPath is string => servedPath !== null);
}

const ordersModule = [
  "from flask_restx import Namespace, Resource",
  "",
  'ns = Namespace("orders", path="/orders")',
  "",
  "",
  '@ns.route("/<int:order_id>")',
  "class OrderDetail(Resource):",
  "    def get(self, order_id):",
  "        pass",
  "",
].join("\n");

describe("a loop over a call that registers routers", () => {
  it("follows the call to the list it returns and composes each path", async () => {
    expect(
      await pathsOf({
        "endpoint/__init__.py": "",
        "endpoint/orders.py": ordersModule,
        "loader.py": [
          "from endpoint.orders import ns as orders_ns",
          "",
          "",
          "def all_namespaces():",
          "    return [orders_ns]",
          "",
        ].join("\n"),
        "app.py": [
          "from flask import Blueprint",
          "from flask_restx import Api",
          "",
          "from loader import all_namespaces",
          "",
          'bp = Blueprint("api", __name__, url_prefix="/api/v1")',
          "api = Api(bp)",
          "",
          "for namespace in all_namespaces():",
          "    api.add_namespace(namespace)",
          "",
        ].join("\n"),
      }),
    ).toEqual(["/api/v1/orders/{order_id}"]);
  });

  it("keeps its abstention when the call returns something it cannot follow", async () => {
    expect(
      await pathsOf({
        "endpoint/__init__.py": "",
        "endpoint/orders.py": ordersModule,
        "loader.py": [
          "def all_namespaces():",
          "    return discover()",
          "",
        ].join("\n"),
        "app.py": [
          "from flask import Blueprint",
          "from flask_restx import Api",
          "",
          "from loader import all_namespaces",
          "",
          'bp = Blueprint("api", __name__, url_prefix="/api/v1")',
          "api = Api(bp)",
          "",
          "for namespace in all_namespaces():",
          "    api.add_namespace(namespace)",
          "",
        ].join("\n"),
      }),
    ).toEqual([]);
  });

  it("keeps its abstention when the returned list has something that is not a router", async () => {
    expect(
      await pathsOf({
        "endpoint/__init__.py": "",
        "endpoint/orders.py": ordersModule,
        "loader.py": [
          "from endpoint.orders import ns as orders_ns",
          "",
          "",
          "def all_namespaces():",
          "    return [orders_ns, something_else]",
          "",
        ].join("\n"),
        "app.py": [
          "from flask import Blueprint",
          "from flask_restx import Api",
          "",
          "from loader import all_namespaces",
          "",
          'bp = Blueprint("api", __name__, url_prefix="/api/v1")',
          "api = Api(bp)",
          "",
          "for namespace in all_namespaces():",
          "    api.add_namespace(namespace)",
          "",
        ].join("\n"),
      }),
    ).toEqual([]);
  });

  it("says which entry stopped the list, and what it resolved to", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loop-"));
    const files: Record<string, string> = {
      "endpoint/__init__.py": "",
      "endpoint/orders.py": ordersModule,
      "loader.py": [
        "from endpoint.orders import ns as orders_ns",
        "",
        "",
        "def all_namespaces():",
        "    return [orders_ns, something_else]",
        "",
      ].join("\n"),
      "app.py": [
        "from flask import Blueprint",
        "from flask_restx import Api",
        "",
        "from loader import all_namespaces",
        "",
        'bp = Blueprint("api", __name__, url_prefix="/api/v1")',
        "api = Api(bp)",
        "",
        "for namespace in all_namespaces():",
        "    api.add_namespace(namespace)",
        "",
      ].join("\n"),
    };
    for (const [name, source] of Object.entries(files)) {
      const full = path.join(dir, name);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, source);
    }
    const { summaries } = await extractPythonProject({
      files: findPythonFiles(dir),
      packs: [flaskRestxLike],
      roots: [dir],
    });

    const gap = (summaries[0]?.gaps ?? [])
      .map((entry) => entry.description)
      .join(" ");
    expect(gap).toContain("1 of 2 entries matched a router");
    expect(gap).toContain("something_else");
    expect(gap).toContain("declined rather than most of it mounted");
  });
});
