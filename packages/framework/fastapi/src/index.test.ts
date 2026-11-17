import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { extractPythonProject, findPythonFiles } from "@suss/adapter-python";

import {
  fastapiFramework,
  fastapiRoutes,
  fastapiWrappers,
  ROUTER_UNREAD,
} from "./index.js";

const SERVES = (method: string) => ({
  role: "serves",
  methods: [method],
  path: [{ at: 0 }],
  handler: { decorated: true },
});

describe("fastapiFramework", () => {
  it("accepts fastapi's own module by default", () => {
    const pack = fastapiFramework();
    expect(pack.name).toBe("fastapi");
    expect(pack.version).toBe("3");
    expect(pack.protocol).toBe("http");
    expect(pack.discovery).toEqual([
      {
        type: "decoratedFunctionRoute",
        importModule: ["fastapi"],
        routes: { table: fastapiRoutes(["fastapi"]), unread: ROUTER_UNREAD },
        pathParamSyntax: "braces",
        annotatedClassIsRequestBody: true,
        injectedParameterCallees: ["Depends", "Security"],
        injectedParameterTypes: expect.arrayContaining([
          "fastapi.Request",
          "fastapi.Response",
          "fastapi.BackgroundTasks",
          "starlette.requests.Request",
        ]),
        parameterSources: {
          Header: { role: "headers", underscoresAs: "-" },
          Query: { role: "queryParams" },
          Path: { role: "pathParams" },
          Body: { role: "requestBody" },
          Form: { role: "requestBody" },
          Cookie: { role: "cookies" },
        },
        parameterAliasKeyword: "alias",
        defaultStatusCode: 200,
        validationFailureStatus: 422,
        statusCodeConstants: expect.objectContaining({
          "fastapi.status.HTTP_404_NOT_FOUND": 404,
          "starlette.status.HTTP_422_UNPROCESSABLE_CONTENT": 422,
        }),
        responseModelKeyword: "response_model",
        statusCodeKeyword: "status_code",
        responsesKeyword: "responses",
        responseStatusCalls: [
          {
            callee: "fastapi.HTTPException",
            statusKeyword: "status_code",
            statusArgument: 0,
          },
          {
            callee: "starlette.exceptions.HTTPException",
            statusKeyword: "status_code",
            statusArgument: 0,
          },
        ],
        responseConstructors: [
          { callee: "fastapi.Response", statusKeyword: "status_code" },
          {
            callee: "starlette.responses.Response",
            statusKeyword: "status_code",
          },
          {
            callee: "fastapi.responses.JSONResponse",
            statusKeyword: "status_code",
          },
          {
            callee: "starlette.responses.JSONResponse",
            statusKeyword: "status_code",
          },
        ],
        wrappers: fastapiWrappers(["fastapi"]),
      },
    ]);
  });

  it("adds a project's wrapper modules alongside fastapi's own", () => {
    const pack = fastapiFramework({ wrapperModules: ["myapp.compat"] });
    const [pattern] = pack.discovery;
    expect(pattern?.type).toBe("decoratedFunctionRoute");
    expect(
      pattern?.type === "decoratedFunctionRoute" && pattern.importModule,
    ).toEqual(["fastapi", "myapp.compat"]);
    expect(
      pattern?.type === "decoratedFunctionRoute" && pattern.routes.table.from,
    ).toEqual(["fastapi", "myapp.compat"]);
  });

  it("reads each verb decorator, api_route, include_router and APIRouter as the table's roles", () => {
    expect(fastapiRoutes(["fastapi"])).toEqual({
      roots: {
        kinds: { FastAPI: 0 },
        children: { in: "receiver" },
        in: "file",
        unlessDropped: { owned: ["middleware", "exception_handler"] },
      },
      from: ["fastapi"],
      joins: "asWritten",
      loops: ["for"],
      throughWrappers: true,
      roles: {
        get: SERVES("GET"),
        post: SERVES("POST"),
        put: SERVES("PUT"),
        patch: SERVES("PATCH"),
        delete: SERVES("DELETE"),
        head: SERVES("HEAD"),
        options: SERVES("OPTIONS"),
        api_route: {
          ...SERVES("GET"),
          methods: { pick: { keyword: "methods" }, unstated: ["GET"] },
        },
        include_router: {
          role: "mount",
          table: [{ at: 0 }, { keyword: "router" }],
          at: [{ keyword: "prefix" }],
          prefix: "inFront",
        },
        APIRouter: {
          role: "scopes",
          path: [{ keyword: "prefix" }],
          children: { in: "receiver" },
          noValue: "unreadable",
          trailingSlash: "kept",
        },
      },
    });
  });

  it("is the module's default export too", async () => {
    const mod = await import("./index.js");
    expect(mod.default).toBe(fastapiFramework);
  });
});

describe("a route an api_route decorator declares", () => {
  it("serves each method a methods list, tuple or set names, upper-cased, and GET when it names none", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fastapi-api-route-"));
    fs.writeFileSync(
      path.join(dir, "main.py"),
      [
        "from fastapi import APIRouter, FastAPI",
        "",
        "app = FastAPI()",
        'router = APIRouter(prefix="/v1")',
        "",
        '@app.api_route("/orders", methods=["GET", "post"])',
        "def orders():",
        "    return []",
        "",
        '@app.api_route("/health")',
        "def health():",
        "    return {}",
        "",
        '@app.api_route("/stock", methods=("DELETE",))',
        "def clear_stock():",
        "    return {}",
        "",
        '@app.api_route("/tags", methods={"PATCH"})',
        "def tag():",
        "    return {}",
        "",
        '@router.api_route("/items/{item_id}", methods=["PUT"])',
        "def replace_item(item_id: int):",
        "    return {}",
        "",
        "app.include_router(router)",
        "",
      ].join("\n"),
    );
    const { summaries } = await extractPythonProject({
      files: findPythonFiles(dir),
      roots: [dir],
      packs: [fastapiFramework()],
      workspaceRoot: dir,
    });
    const served = summaries.flatMap((summary) => {
      const semantics = summary.identity.boundaryBinding?.semantics;
      return semantics?.name === "rest"
        ? [`${summary.identity.name} ${semantics.method} ${semantics.path}`]
        : [];
    });
    expect(served.sort()).toEqual([
      "clear_stock DELETE /stock",
      "health GET /health",
      "orders GET /orders",
      "orders POST /orders",
      "replace_item PUT /v1/items/{item_id}",
      "tag PATCH /tags",
    ]);
  });
});
