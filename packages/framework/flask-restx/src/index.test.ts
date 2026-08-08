import { describe, expect, it } from "vitest";

import {
  bindModule,
  buildRouterIndex,
  discoverUnits,
  parsePython,
} from "@suss/adapter-python";

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
  async function unitsOf(setup: string[]) {
    const source = [
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
    ].join("\n");

    const packs = [flaskRestxFramework()];
    const tree = await parsePython(source);
    const module = bindModule(tree.rootNode);
    return discoverUnits(tree.rootNode, module, {
      packs,
      filePath: "main.py",
      routerIndex: buildRouterIndex(
        [
          {
            file: "/proj/main.py",
            displayPath: "main.py",
            root: tree.rootNode,
            module,
          },
        ],
        packs,
        { roots: [] },
      ),
    });
  }

  async function pathOf(setup: string[], name: string) {
    const units = await unitsOf(setup);
    const unit = units.find((candidate) => candidate.identity.name === name);
    const semantics = unit?.boundaryBinding?.semantics;
    return semantics?.name === "rest" ? semantics.path : undefined;
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
});
