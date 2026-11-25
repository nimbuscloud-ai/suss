import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { extractPythonProject, findPythonFiles } from "@suss/adapter-python";
import { readServedBesideMetadata } from "@suss/behavioral-ir";

import {
  flaskRestxFramework,
  flaskRestxRoutes,
  flaskRestxWrappers,
  ROUTER_UNREAD,
} from "./index.js";

describe("flaskRestxFramework", () => {
  it("accepts flask_restx's own module by default", () => {
    const pack = flaskRestxFramework();
    expect(pack.name).toBe("flask-restx");
    expect(pack.version).toBe("3");
    expect(pack.protocol).toBe("http");
    expect(pack.discovery).toEqual([
      {
        type: "decoratedClassRoute",
        importModule: ["flask_restx"],
        routes: {
          table: flaskRestxRoutes(["flask_restx"]),
          unread: ROUTER_UNREAD,
        },
        pathParamSyntax: "flaskConverters",
        defaultStatusCode: 200,
        statusFromReturnedTuple: true,
        responseStatusCalls: [
          { callee: "flask_restx.abort", statusArgument: 0 },
          { callee: "flask.abort", statusArgument: 0 },
          { callee: "werkzeug.exceptions.abort", statusArgument: 0 },
        ],
        wrappers: flaskRestxWrappers(["flask_restx"]),
      },
    ]);
  });

  it("adds a project's wrapper modules alongside flask_restx's own", () => {
    const pack = flaskRestxFramework({
      wrapperModules: ["myapp.wrappers.restx"],
    });
    const [pattern] = pack.discovery;
    expect(pattern?.type).toBe("decoratedClassRoute");
    expect(
      pattern?.type === "decoratedClassRoute" && pattern.importModule,
    ).toEqual(["flask_restx", "myapp.wrappers.restx"]);
    expect(pattern?.routes.table.from).toEqual([
      "flask_restx",
      "myapp.wrappers.restx",
    ]);
  });

  it("serves a resource method under its name upper-cased, for every method a resource can write", () => {
    const route = flaskRestxRoutes(["flask_restx"]).roles.route;
    expect(route?.role === "serves" && route.methods).toEqual({
      members: ["get", "post", "put", "delete", "patch", "head", "options"],
    });
  });

  it("is the module's default export too", async () => {
    const mod = await import("./index.js");
    expect(mod.default).toBe(flaskRestxFramework);
  });
});

describe("the path the shipped pack composes for a blueprint-mounted route", () => {
  /** A project on disk, since the mount is read through the facts a run emits. */
  async function servedPath(files: Record<string, string>, name: string) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flask-restx-"));
    for (const [file, source] of Object.entries(files)) {
      const full = path.join(dir, file);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, source);
    }
    const { summaries } = await extractPythonProject({
      files: findPythonFiles(dir),
      packs: [flaskRestxFramework()],
      roots: [dir],
      workspaceRoot: dir,
    });
    const semantics = summaries.find(
      (summary) => summary.identity.name === name,
    )?.identity.boundaryBinding?.semantics;
    return semantics?.name === "rest" ? semantics.path : undefined;
  }

  /** One file that opens with the library's imports, states the setup, and declares one route on a namespace. */
  async function pathOf(setup: string[], name: string) {
    return servedPath(
      {
        "main.py": [
          "from flask import Blueprint, Flask",
          "from flask_restx import Api, Namespace",
          "",
          ...setup,
          'ns = Namespace("orders", path="/orders")',
          "",
          "",
          '@ns.route("/<int:order_id>")',
          "class OrderDetail:",
          "    def get(self, order_id):",
          "        return {}",
          "",
          "",
          "api.add_namespace(ns)",
          "",
        ].join("\n"),
      },
      name,
    );
  }

  it("puts the blueprint's prefix in front of the namespace's path", async () => {
    expect(
      await pathOf(
        [
          'bp = Blueprint("api", __name__, url_prefix="/api/v1")',
          "app = Flask(__name__)",
          "api = Api(bp)",
          "app.register_blueprint(bp)",
        ],
        "OrderDetail.get",
      ),
    ).toBe("/api/v1/orders/{order_id}");
  });

  it("serves a trailing slash on the blueprint's prefix at the merged path", async () => {
    expect(
      await pathOf(
        [
          'bp = Blueprint("api", __name__, url_prefix="/api/v1/")',
          "app = Flask(__name__)",
          "api = Api(bp)",
          "app.register_blueprint(bp)",
        ],
        "OrderDetail.get",
      ),
    ).toBe("/api/v1/orders/{order_id}");
  });

  it("merges both doubled slashes when the blueprint's prefix and the Api's both trail", async () => {
    expect(
      await pathOf(
        [
          'bp = Blueprint("api", __name__, url_prefix="/api/v1/")',
          "app = Flask(__name__)",
          'api = Api(bp, prefix="/extra/")',
          "app.register_blueprint(bp)",
        ],
        "OrderDetail.get",
      ),
    ).toBe("/api/v1/extra/orders/{order_id}");
  });

  it("reads a blueprint the app module imports from the module that built it", async () => {
    expect(
      await servedPath(
        {
          "shared/__init__.py": "",
          "shared/blueprints.py": [
            "from flask import Blueprint",
            "",
            'api_bp = Blueprint("api", __name__, url_prefix="/api/v1")',
            "",
          ].join("\n"),
          "main.py": [
            "from flask import Flask",
            "from flask_restx import Api, Namespace",
            "",
            "from shared.blueprints import api_bp",
            "",
            "app = Flask(__name__)",
            "api = Api(api_bp)",
            'ns = Namespace("orders", path="/orders")',
            "",
            "",
            '@ns.route("/<int:order_id>")',
            "class OrderDetail:",
            "    def get(self, order_id):",
            "        return {}",
            "",
            "",
            "api.add_namespace(ns)",
            "app.register_blueprint(api_bp)",
            "",
          ].join("\n"),
        },
        "OrderDetail.get",
      ),
    ).toBe("/api/v1/orders/{order_id}");
  });
});

/** What the pack states beside the app's routes, each as `by methods path`, with `*` for every method and `any` for any path. */
async function besideOf(lines: readonly string[]): Promise<string[]> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flask-restx-beside-"));
  fs.writeFileSync(path.join(dir, "app.py"), [...lines, ""].join("\n"));
  const { summaries } = await extractPythonProject({
    files: findPythonFiles(dir),
    roots: [dir],
    packs: [flaskRestxFramework()],
    workspaceRoot: dir,
  });
  const route = summaries.find(
    (summary) =>
      summary.identity.boundaryBinding?.recognition === "flask-restx",
  );
  const statement =
    route === undefined ? undefined : readServedBesideMetadata(route);
  return (statement?.entries ?? []).map(
    (entry) =>
      `${entry.by} ${entry.methods?.join(",") ?? "*"} ${entry.path ?? "any"}`,
  );
}

const ORDERS_API = [
  "from flask import Blueprint, Flask",
  "from flask_restx import Api, Namespace, Resource",
  "",
  "app = Flask(__name__)",
  'api_bp = Blueprint("api", __name__, url_prefix="/api")',
  "api = Api(api_bp, doc=False)",
  'ns = Namespace("orders", path="/orders")',
  "",
  '@ns.route("/<int:order_id>")',
  "class OrderDetail(Resource):",
  "    def get(self, order_id):",
  "        return {}",
  "",
  "api.add_namespace(ns)",
  "app.register_blueprint(api_bp)",
];

describe("what a flask-restx app serves beside its resources", () => {
  it("lists the static folder, Flask's own routes under where each blueprint is registered, and the Swagger document", async () => {
    const beside = await besideOf([
      ...ORDERS_API,
      'reports = Blueprint("reports", __name__)',
      'drafts = Blueprint("drafts", __name__, url_prefix="/drafts")',
      'app.register_blueprint(reports, url_prefix="/reports")',
      "",
      '@app.route("/health", methods=["GET", "POST"])',
      "def health():",
      "    return {}",
      "",
      '@reports.get("/<path:name>")',
      "def report(name):",
      "    return {}",
      "",
      '@drafts.route("/<int:draft_id>")',
      "def draft(draft_id):",
      "    return {}",
      "",
      'api.add_resource(OrderDetail, "/legacy/<int:order_id>")',
    ]);

    expect(beside).toEqual([
      "static GET,HEAD /static/{path*}",
      "page GET,HEAD /swagger.json",
      "page GET,HEAD /api/swagger.json",
      "page GET,HEAD /api/orders/swagger.json",
      "mount * /reports/{path*}",
      "unread GET,POST /health",
      "unread GET /reports/{name+}",
      "unread GET any",
      "unread * any",
    ]);
  });

  it("serves the static folder where its keywords put it, and nothing when it is None", async () => {
    const at = async (construction: string): Promise<string[]> =>
      (
        await besideOf(
          ORDERS_API.map((line) =>
            line === "app = Flask(__name__)" ? construction : line,
          ),
        )
      ).filter((entry) => entry.startsWith("static"));

    expect(
      await at(
        'app = Flask(__name__, static_folder="../web/dist", static_url_path="")',
      ),
    ).toEqual(["static GET,HEAD /{path*}"]);
    expect(await at('app = Flask(__name__, static_folder="assets")')).toEqual([
      "static GET,HEAD /assets/{path*}",
    ]);
    expect(await at("app = Flask(__name__, static_folder=None)")).toEqual([]);
    expect(await at("app = Flask(__name__, static_folder=FOLDER)")).toEqual([
      "static GET,HEAD any",
    ]);
  });

  it("lists a hook or an error handler only when it may respond to a path no route serves", async () => {
    const beside = await besideOf([
      "from flask import request, send_file",
      ...ORDERS_API,
      "",
      "app.register_error_handler(404, lambda error: send_file('index.html'))",
      "app.register_error_handler(ValueError, lambda error: ({}, 400))",
      "",
      "@app.before_request",
      "def check_token():",
      '    if request.headers.get("x-block"):',
      '        return {"error": "blocked"}, 403',
      "    return None",
      "",
      "@app.errorhandler(404)",
      "def not_found(error):",
      '    return {"error": "not found"}, 404',
      "",
      "@app.errorhandler(500)",
      "def single_page(error):",
      '    return send_file("index.html")',
    ]);

    expect(
      beside.filter(
        (entry) => entry.startsWith("unread") || entry.startsWith("middleware"),
      ),
    ).toEqual(["unread * any", "middleware * any"]);
  });
});
