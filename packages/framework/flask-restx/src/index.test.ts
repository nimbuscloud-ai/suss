import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { extractPythonProject, findPythonFiles } from "@suss/adapter-python";

import { flaskRestxFramework } from "./index.js";

describe("flaskRestxFramework", () => {
  it("accepts flask_restx's own module by default", () => {
    const pack = flaskRestxFramework();
    expect(pack.name).toBe("flask-restx");
    expect(pack.protocol).toBe("http");
    expect(pack.discovery).toEqual([
      {
        type: "decoratedClassRoute",
        importModule: ["flask_restx"],
        decoratorName: "route",
        verbMethodNames: {
          get: "GET",
          post: "POST",
          put: "PUT",
          delete: "DELETE",
          patch: "PATCH",
          head: "HEAD",
          options: "OPTIONS",
        },
        pathParamSyntax: "flaskConverters",
        pathRepeatedSlashes: "merged",
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
        defaultStatusCode: 200,
        statusFromReturnedTuple: true,
        responseStatusCalls: [
          { callee: "flask_restx.abort", statusArgument: 0 },
          { callee: "flask.abort", statusArgument: 0 },
          { callee: "werkzeug.exceptions.abort", statusArgument: 0 },
        ],
        wrappers: [
          {
            type: "decoratedWrapper",
            attribute: "before_request",
            registrars: [
              {
                constructorName: "Flask",
                importModule: ["flask"],
                covers: "everyRoute",
              },
            ],
            returnedValueResponds: true,
          },
          {
            type: "decoratedWrapper",
            attribute: "errorhandler",
            registrars: [
              {
                constructorName: "Flask",
                importModule: ["flask"],
                covers: "everyRoute",
              },
              { constructorName: "Api", covers: "everyRoute" },
              { constructorName: "Namespace", covers: "ownRoutes" },
            ],
            throwParam: 0,
          },
        ],
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
