// A decorator written through a project's own wrapper function, which is how
// several measured services declare every route:
//
//     def api_route(path):
//         return orders_namespace.route(path)
//
// The wrapper is read where it is written, and the decorator is classified as
// what the wrapper returns. A wrapper whose body does anything more keeps the
// route undiscovered, the same as any decorator nothing recognizes.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { extractPythonProject, findPythonFiles } from "./index.js";

import type { PythonPack } from "./pack.js";

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

const WRAPPERS = [
  "from flask_restx import Namespace",
  "",
  'orders_namespace = Namespace("orders", path="/orders")',
  "",
  "",
  "def api_route(path):",
  "    return orders_namespace.route(path)",
  "",
].join("\n");

const APP = [
  "from flask import Blueprint",
  "from flask_restx import Api",
  "",
  "from myapp.wrappers import orders_namespace",
  "",
  'bp = Blueprint("api", __name__, url_prefix="/api/v1")',
  "api = Api(bp)",
  "api.add_namespace(orders_namespace)",
  "",
].join("\n");

async function pathsOf(files: Record<string, string>): Promise<string[]> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wrapper-"));
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
  return summaries.map((summary) => {
    const semantics = summary.identity.boundaryBinding?.semantics;
    if (semantics?.name === "rest" && semantics.path === null) {
      return `<none: ${(summary.gaps ?? [])[0]?.description?.slice(0, 90) ?? ""}>`;
    }
    return semantics?.name === "rest" ? (semantics.path ?? "<none>") : "<none>";
  });
}

describe("a decorator written through a project wrapper", () => {
  it("composes the full path, wrapper in another file", async () => {
    const paths = await pathsOf({
      "myapp/__init__.py": "",
      "myapp/wrappers.py": WRAPPERS,
      "myapp/routes/__init__.py": "",
      "myapp/routes/orders.py": [
        "from flask_restx import Resource",
        "",
        "from myapp.wrappers import api_route",
        "",
        "",
        '@api_route("/<int:order_id>")',
        "class OrderDetail(Resource):",
        "    def get(self, order_id):",
        "        return {}",
        "",
      ].join("\n"),
      "app.py": APP,
    });
    expect(paths).toEqual(["/api/v1/orders/{order_id}"]);
  });

  it("composes the full path, wrapper in the same file", async () => {
    const paths = await pathsOf({
      "myapp/__init__.py": "",
      "myapp/wrappers.py": WRAPPERS,
      "myapp/routes/__init__.py": "",
      "myapp/routes/orders.py": [
        "from flask_restx import Namespace, Resource",
        "",
        'local_namespace = Namespace("orders", path="/orders")',
        "",
        "",
        "def local_route(path):",
        "    return local_namespace.route(path)",
        "",
        "",
        '@local_route("/summary")',
        "class OrderSummary(Resource):",
        "    def get(self):",
        "        return {}",
        "",
      ].join("\n"),
      "app.py": [
        "from flask import Blueprint",
        "from flask_restx import Api",
        "",
        "from myapp.routes.orders import local_namespace",
        "",
        'bp = Blueprint("api", __name__, url_prefix="/api/v1")',
        "api = Api(bp)",
        "api.add_namespace(local_namespace)",
        "",
      ].join("\n"),
    });
    expect(paths).toEqual(["/api/v1/orders/summary"]);
  });

  it("keeps a wrapper with a second statement undiscovered", async () => {
    const paths = await pathsOf({
      "myapp/__init__.py": "",
      "myapp/wrappers.py": [
        "from flask_restx import Namespace",
        "",
        'orders_namespace = Namespace("orders", path="/orders")',
        "",
        "",
        "def api_route(path):",
        "    audit(path)",
        "    return orders_namespace.route(path)",
        "",
      ].join("\n"),
      "myapp/routes/__init__.py": "",
      "myapp/routes/orders.py": [
        "from flask_restx import Resource",
        "",
        "from myapp.wrappers import api_route",
        "",
        "",
        '@api_route("/<int:order_id>")',
        "class OrderDetail(Resource):",
        "    def get(self, order_id):",
        "        return {}",
        "",
      ].join("\n"),
      "app.py": APP,
    });
    expect(paths).toEqual([]);
  });

  it("keeps a wrapper that rearranges its arguments undiscovered", async () => {
    const paths = await pathsOf({
      "myapp/__init__.py": "",
      "myapp/wrappers.py": [
        "from flask_restx import Namespace",
        "",
        'orders_namespace = Namespace("orders", path="/orders")',
        "",
        "",
        "def api_route(path, extra):",
        "    return orders_namespace.route(extra)",
        "",
      ].join("\n"),
      "myapp/routes/__init__.py": "",
      "myapp/routes/orders.py": [
        "from flask_restx import Resource",
        "",
        "from myapp.wrappers import api_route",
        "",
        "",
        '@api_route("/<int:order_id>", "/other")',
        "class OrderDetail(Resource):",
        "    def get(self, order_id):",
        "        return {}",
        "",
      ].join("\n"),
      "app.py": APP,
    });
    expect(paths).toEqual([]);
  });

  it("keeps a wrapper returning a bare-name call undiscovered", async () => {
    const paths = await pathsOf({
      "myapp/__init__.py": "",
      "myapp/wrappers.py": [
        "def api_route(path):",
        "    return build_route(path)",
        "",
      ].join("\n"),
      "myapp/routes/__init__.py": "",
      "myapp/routes/orders.py": [
        "from flask_restx import Resource",
        "",
        "from myapp.wrappers import api_route",
        "",
        "",
        '@api_route("/x")',
        "class OrderDetail(Resource):",
        "    def get(self):",
        "        return {}",
        "",
      ].join("\n"),
    });
    expect(paths).toEqual([]);
  });

  it("keeps a wrapper whose namespace nothing resolves undiscovered", async () => {
    const paths = await pathsOf({
      "myapp/__init__.py": "",
      "myapp/wrappers.py": [
        "def api_route(path):",
        "    return mystery.route(path)",
        "",
      ].join("\n"),
      "myapp/routes/__init__.py": "",
      "myapp/routes/orders.py": [
        "from flask_restx import Resource",
        "",
        "from myapp.wrappers import api_route",
        "",
        "",
        '@api_route("/x")',
        "class OrderDetail(Resource):",
        "    def get(self):",
        "        return {}",
        "",
      ].join("\n"),
    });
    expect(paths).toEqual([]);
  });

  it("keeps a decorated name that is not a call undiscovered", async () => {
    const paths = await pathsOf({
      "myapp/__init__.py": "",
      "myapp/routes.py": [
        "from flask_restx import Resource",
        "",
        "",
        "@unknown_marker",
        "class OrderDetail(Resource):",
        "    def get(self):",
        "        return {}",
        "",
      ].join("\n"),
    });
    expect(paths).toEqual([]);
  });

  it("keeps an attribute decorator on an unresolved object undiscovered", async () => {
    const paths = await pathsOf({
      "myapp/__init__.py": "",
      "myapp/routes.py": [
        "from flask_restx import Resource",
        "",
        "",
        '@mystery.route("/x")',
        "class OrderDetail(Resource):",
        "    def get(self):",
        "        return {}",
        "",
      ].join("\n"),
    });
    expect(paths).toEqual([]);
  });

  it("keeps a wrapper imported from a module outside the run undiscovered", async () => {
    const paths = await pathsOf({
      "myapp/__init__.py": "",
      "myapp/routes.py": [
        "from flask_restx import Resource",
        "",
        "from vendored.helpers import api_route",
        "",
        "",
        '@api_route("/x")',
        "class OrderDetail(Resource):",
        "    def get(self):",
        "        return {}",
        "",
      ].join("\n"),
    });
    expect(paths).toEqual([]);
  });

  it("keeps a decorator whose name refers to something other than a def undiscovered", async () => {
    const paths = await pathsOf({
      "myapp/__init__.py": "",
      "myapp/wrappers.py": ["not_a_def = 5", ""].join("\n"),
      "myapp/routes.py": [
        "from flask_restx import Resource",
        "",
        "from myapp.wrappers import not_a_def",
        "",
        "",
        '@not_a_def("/x")',
        "class OrderDetail(Resource):",
        "    def get(self):",
        "        return {}",
        "",
      ].join("\n"),
    });
    expect(paths).toEqual([]);
  });
});
