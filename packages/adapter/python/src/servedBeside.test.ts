import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { readServedBesideMetadata } from "@suss/behavioral-ir";
import { constructedFrom, imported } from "@suss/recognize";

import {
  fastapiTestRoutes,
  fastapiTestWrappers,
} from "./__fixtures__/fastapiPattern.js";
import {
  flaskRestxTestPattern,
  flaskRestxTestWrappers,
} from "./__fixtures__/flaskRestxPattern.js";
import { findPythonFiles } from "./index.js";
import { extractPythonProject } from "./project.js";

import type { PyServedBeside, PythonPack } from "./pack.js";

/** What the pack states beside the run's first route, each as `by methods path`, with `*` for every method and `any` for any path. */
async function besideOf(
  pack: PythonPack,
  lines: readonly string[],
  others: Readonly<Record<string, readonly string[]>> = {},
): Promise<string[]> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "python-beside-"));
  for (const [file, text] of Object.entries({ "main.py": lines, ...others })) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), [...text, ""].join("\n"));
  }
  const { summaries } = await extractPythonProject({
    files: findPythonFiles(dir),
    roots: [dir],
    packs: [pack],
    workspaceRoot: dir,
  });
  const route = summaries.find(
    (summary) => summary.identity.boundaryBinding?.recognition === pack.name,
  );
  const statement =
    route === undefined ? undefined : readServedBesideMetadata(route);
  return (statement?.entries ?? []).map(
    (entry) =>
      `${entry.by} ${entry.methods?.join(",") ?? "*"} ${entry.path ?? "any"}`,
  );
}

const FASTAPI_BESIDE: PyServedBeside = {
  runners: [imported({ from: ["uvicorn"], named: ["run"] })],
  servers: [
    {
      made: constructedFrom({ from: ["fastapi"], named: ["FastAPI"] }),
      paths: "asWritten",
      builtIn: [
        { keyword: "docs_url", path: "/docs", methods: ["GET"], under: "app" },
      ],
      unreadKeywords: ["routes"],
      inert: ["on_event", "state"],
      calls: {
        add_api_route: {
          serves: "route",
          path: [{ at: 0 }],
          methods: { pick: { keyword: "methods" }, unstated: ["GET"] },
        },
        add_route: {
          serves: "route",
          path: [{ at: 0 }],
          methods: { pick: { keyword: "methods" } },
        },
        mount: {
          serves: "mount",
          at: [{ at: 0 }],
          app: [{ at: 1 }],
          staticServers: [
            {
              module: "fastapi.staticfiles",
              names: ["StaticFiles"],
              by: "static",
            },
          ],
        },
        add_middleware: {
          serves: "middleware",
          middleware: [{ at: 0 }],
          known: [
            {
              module: "fastapi.middleware.cors",
              names: ["CORSMiddleware"],
              respondsTo: ["OPTIONS"],
            },
            {
              module: "fastapi.middleware.gzip",
              names: ["GZipMiddleware"],
              respondsTo: [],
            },
          ],
        },
        add_exception_handler: {
          serves: "errorHandler",
          handles: [{ at: 0 }],
          notFound: {
            status: 404,
            modules: ["starlette.exceptions"],
            ancestors: ["Exception"],
          },
        },
      },
    },
    {
      made: constructedFrom({ from: ["fastapi"], named: ["APIRouter"] }),
      paths: "underPrefix",
      calls: {
        add_api_route: {
          serves: "route",
          path: [{ at: 0 }],
          methods: ["GET"],
        },
      },
    },
  ],
};

const fastapiPack: PythonPack = {
  name: "fastapi",
  protocol: "http",
  servedBeside: FASTAPI_BESIDE,
  discovery: [
    {
      type: "decoratedFunctionRoute",
      importModule: ["fastapi"],
      routes: fastapiTestRoutes(),
      pathParamSyntax: "braces",
      defaultStatusCode: 200,
      responseConstructors: [
        {
          callee: "fastapi.responses.JSONResponse",
          statusKeyword: "status_code",
        },
      ],
      wrappers: fastapiTestWrappers(),
    },
  ],
};

const FASTAPI_APP = [
  "from fastapi import APIRouter, FastAPI",
  "",
  "app = FastAPI()",
  'router = APIRouter(prefix="/v1")',
  "",
  '@router.get("/orders/{order_id}")',
  "def order(order_id: str):",
  "    return {}",
  "",
  "app.include_router(router)",
];

describe("what a Python framework serves beside its routes", () => {
  it("reads the app's pages, its mounts, and the routes a call adds, at the paths they state", async () => {
    const beside = await besideOf(fastapiPack, [
      ...FASTAPI_APP,
      "",
      "from fastapi.staticfiles import StaticFiles",
      "from library import library_router, sub_app",
      "",
      'app.mount("/static/", StaticFiles(directory="static"))',
      'app.mount("/sub", sub_app)',
      "app.mount(MOUNTED_AT, sub_app)",
      'app.include_router(library_router, prefix="/auth")',
      'app.add_api_route("/health", order)',
      'app.add_api_route("/drafts", order, methods=["post", "put"])',
      'app.add_route("/files/{rest:path}", order)',
      "app.add_route(FILE_PATH, order, methods=VERBS)",
      'router.add_api_route("/extra", order)',
    ]);

    expect(beside).toEqual([
      "page GET /docs",
      "static GET,HEAD /static/{path*}",
      "mount * /sub/{path*}",
      "mount * any",
      "unread GET /health",
      "unread POST,PUT /drafts",
      "unread * /files/{rest*}",
      "unread * any",
      "unread GET any",
      "mount * /auth/{path*}",
    ]);
  });

  it("leaves out a page its keyword turns off, and reads one it cannot read, and a keyword it does not read, as any path", async () => {
    const at = async (construction: string): Promise<string[]> =>
      besideOf(
        fastapiPack,
        FASTAPI_APP.map((line) =>
          line === "app = FastAPI()" ? construction : line,
        ),
      );

    expect(await at("app = FastAPI(docs_url=None)")).toEqual([]);
    expect(await at('app = FastAPI(docs_url="")')).toEqual([]);
    expect(await at('app = FastAPI(docs_url="/help")')).toEqual([
      "page GET /help",
    ]);
    expect(await at("app = FastAPI(docs_url=DOCS, routes=ROUTES)")).toEqual([
      "page GET any",
      "unread * any",
    ]);
  });

  it("reads middleware and an error handler by what each may serve when no route matches", async () => {
    const beside = await besideOf(fastapiPack, [
      ...FASTAPI_APP,
      "",
      "from fastapi.middleware.cors import CORSMiddleware",
      "from fastapi.middleware.gzip import GZipMiddleware",
      "from fastapi.responses import FileResponse, JSONResponse",
      "from starlette.exceptions import HTTPException",
      "from limits import RateLimited, handle",
      "from metrics import MetricsMiddleware",
      "",
      "class Conflict(Exception):",
      "    pass",
      "",
      "app.add_middleware(CORSMiddleware)",
      "app.add_middleware(GZipMiddleware)",
      "app.add_middleware(MetricsMiddleware)",
      "app.add_exception_handler(RateLimited, handle)",
      "app.add_exception_handler(409, handle)",
      "app.add_exception_handler(Conflict, handle)",
      "app.add_exception_handler(404, handle)",
      "app.add_exception_handler(HTTPException, handle)",
      "app.add_exception_handler(Exception, handle)",
      "app.add_exception_handler(errors[0], handle)",
      "",
      '@app.middleware("http")',
      "async def timing(request, call_next):",
      "    response = await call_next(request)",
      "    return response",
      "",
      '@app.middleware("http")',
      "async def guard(request, call_next):",
      '    if request.headers.get("x-block"):',
      '        return JSONResponse({"detail": "blocked"}, status_code=403)',
      "    return await call_next(request)",
      "",
      "@app.exception_handler(HTTPException)",
      "async def single_page(request, exc):",
      '    return FileResponse("index.html")',
    ]);

    expect(beside.filter((entry) => !entry.startsWith("page"))).toEqual([
      "middleware OPTIONS any",
      "middleware * any",
      "unread * any",
      "unread * any",
      "unread * any",
      "unread * any",
      "middleware * any",
    ]);
  });

  it("lists middleware that may send something other than what its continuation returned", async () => {
    const middleware = async (body: readonly string[]): Promise<string[]> =>
      (
        await besideOf(fastapiPack, [
          ...FASTAPI_APP,
          "",
          "from fastapi.responses import FileResponse",
          "",
          '@app.middleware("http")',
          "async def fallback(request, call_next):",
          ...body,
        ])
      ).filter((entry) => entry.startsWith("middleware"));

    expect(
      await middleware([
        "    response = await call_next(request)",
        "    if response.status_code == 404:",
        '        return FileResponse("index.html")',
        "    return response",
      ]),
    ).toEqual(["middleware * any"]);
    expect(
      await middleware([
        "    response = await call_next(request)",
        '    response.headers["x-served-by"] = "shop"',
        "    return response",
      ]),
    ).toEqual([]);
  });

  it("writes nothing for a pack that states nothing, or that recognized no route", async () => {
    const { servedBeside: _, ...silent } = fastapiPack;

    expect(await besideOf(silent, FASTAPI_APP)).toEqual([]);
    expect(
      await besideOf(fastapiPack, [
        "from fastapi import FastAPI",
        "app = FastAPI()",
      ]),
    ).toEqual([]);
  });
});

describe("where a Python app goes", () => {
  const unreadOf = (beside: readonly string[]): string[] =>
    beside.filter((entry) => entry.startsWith("unread"));

  it("covers any path wherever the app meets code suss does not read", async () => {
    const beside = await besideOf(fastapiPack, [
      ...FASTAPI_APP,
      "",
      "from shop_metrics import Exporter, describe",
      "from edge_proxy import EdgeMiddleware",
      "",
      'app.frontend("/", directory="site")',
      "Exporter().expose(app)",
      "served = EdgeMiddleware(app)",
      'app.router.add_route("/x", order)',
      'registry = {"app": app}',
      "describe(app.router)",
    ]);

    expect(unreadOf(beside)).toEqual([
      "unread * any",
      "unread * any",
      "unread * any",
      "unread * any",
      "unread * any",
      "unread * any",
    ]);
  });

  it("leaves out what the pack lists, a runner, a server it builds, and the project's own function", async () => {
    const beside = await besideOf(fastapiPack, [
      ...FASTAPI_APP,
      "",
      "import uvicorn",
      "",
      "sub = FastAPI()",
      'app.mount("/sub", sub)',
      "app.state.ready = True",
      "",
      '@app.on_event("startup")',
      "def started():",
      "    pass",
      "",
      "def add_health(server):",
      '    server.add_api_route("/health", order)',
      "",
      "add_health(app)",
      "uvicorn.run(app)",
      "uvicorn.run(app.router)",
    ]);

    expect(beside.filter((entry) => !entry.startsWith("page"))).toEqual([
      "mount * /sub/{path*}",
      "unread GET /health",
    ]);
  });

  it("reads a serving call on the app a module of its package imports", async () => {
    const beside = await besideOf(fastapiPack, ["from app.main import app"], {
      "app/__init__.py": [],
      "app/main.py": FASTAPI_APP,
      "app/legacy.py": [
        "from app.main import app",
        "",
        'app.mount("/legacy", None)',
      ],
    });

    expect(beside.filter((entry) => !entry.startsWith("page"))).toEqual([
      "mount * /legacy/{path*}",
    ]);
  });
});

const flaskPack: PythonPack = {
  name: "flask-restx",
  protocol: "http",
  servedBeside: {
    servers: [
      {
        made: constructedFrom({ from: ["flask"], named: ["Flask"] }),
        paths: "asWritten",
        staticFolder: {
          folder: { keyword: "static_folder", default: "static" },
          urlPath: "static_url_path",
          positionalBefore: 1,
          methods: ["GET"],
        },
        calls: {
          route: {
            serves: "route",
            path: [{ at: 0 }],
            methods: { pick: { keyword: "methods" }, unstated: ["GET"] },
          },
          register_blueprint: {
            serves: "mount",
            at: [{ keyword: "url_prefix" }],
            app: [{ at: 0 }],
            ownPath: [{ keyword: "url_prefix" }],
            exceptCarriers: true,
          },
        },
      },
      {
        made: constructedFrom({ from: ["flask"], named: ["Blueprint"] }),
        paths: "underPrefix",
        servedWhereRegistered: true,
        staticFolder: {
          folder: { keyword: "static_folder", default: null },
          urlPath: "static_url_path",
          positionalBefore: 2,
          methods: ["GET"],
        },
        calls: {
          route: {
            serves: "route",
            path: [{ at: 0 }],
            methods: { pick: { keyword: "methods" }, unstated: ["GET"] },
          },
        },
      },
      {
        made: constructedFrom({ from: ["flask_restx"], named: ["Api"] }),
        paths: "underPrefix",
        builtIn: [
          {
            keyword: "doc",
            path: "/",
            methods: ["GET"],
            under: "routes",
          },
        ],
        calls: {},
      },
    ],
  },
  discovery: [
    {
      ...flaskRestxTestPattern(),
      defaultStatusCode: 200,
      statusFromReturnedTuple: true,
      wrappers: flaskRestxTestWrappers(),
    },
  ],
};

const FLASK_APP = [
  "from flask import Blueprint, Flask",
  "from flask_restx import Api, Namespace, Resource",
  "",
  "app = Flask(__name__)",
  'api_bp = Blueprint("api", __name__, url_prefix="/api")',
  "api = Api(api_bp)",
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

describe("what a Flask app serves beside the resources its pack reads", () => {
  it("serves a blueprint's own routes under each place it is registered, and any path where that does not read", async () => {
    const beside = await besideOf(flaskPack, [
      ...FLASK_APP,
      'reports = Blueprint("reports", __name__, url_prefix="/reports")',
      'drafts = Blueprint("drafts", __name__)',
      'assets = Blueprint("assets", __name__, static_folder="files")',
      "app.register_blueprint(reports)",
      'app.register_blueprint(reports, url_prefix="/v2/reports")',
      "app.register_blueprint(assets, url_prefix=ASSETS)",
      "",
      '@api_bp.route("/ping")',
      "def ping():",
      "    return {}",
      "",
      '@reports.route("/<path:name>", methods=["GET", "DELETE"])',
      "def report(name):",
      "    return {}",
      "",
      '@drafts.route("/<int:draft_id>")',
      "def draft(draft_id):",
      "    return {}",
    ]);

    expect(beside).toEqual([
      "static GET /static/{path*}",
      "page GET /",
      "page GET /api",
      "page GET /api/orders",
      "static GET any",
      "mount * /reports/{path*}",
      "mount * /v2/reports/{path*}",
      "mount * any",
      "unread GET /api/ping",
      "unread GET,DELETE /reports/{name+}",
      "unread GET,DELETE /v2/reports/{name+}",
      "unread GET any",
    ]);
  });

  it("lists a resource the table declares and no summary serves, at any path when its own does not read", async () => {
    const beside = await besideOf(flaskPack, [
      ...FLASK_APP,
      "",
      "@ns.route(LEGACY_PATH)",
      "class Legacy(Resource):",
      "    def post(self):",
      "        return {}",
    ]);

    expect(beside.filter((entry) => entry.startsWith("unread"))).toEqual([
      "unread POST any",
    ]);
  });

  it("serves the static folder where its keywords put it", async () => {
    const at = async (construction: string): Promise<string[]> =>
      (
        await besideOf(
          flaskPack,
          FLASK_APP.map((line) =>
            line === "app = Flask(__name__)" ? construction : line,
          ),
        )
      ).filter((entry) => entry.startsWith("static"));

    expect(
      await at(
        'app = Flask(__name__, static_folder="../web/dist", static_url_path="")',
      ),
    ).toEqual(["static GET /{path*}"]);
    expect(await at("app = Flask(__name__, static_url_path=None)")).toEqual([
      "static GET /static/{path*}",
    ]);
    expect(await at("app = Flask(__name__, static_folder=None)")).toEqual([]);
    expect(await at("app = Flask(__name__, static_folder=FOLDER)")).toEqual([
      "static GET any",
    ]);
    expect(await at("app = Flask(__name__, static_url_path=PREFIX)")).toEqual([
      "static GET any",
    ]);
    expect(await at('app = Flask(__name__, "/files")')).toEqual([
      "static GET any",
    ]);
  });

  it("reads a before_request hook by whether it may respond itself with anything but an error", async () => {
    const hooks = async (body: readonly string[]): Promise<string[]> =>
      (
        await besideOf(flaskPack, [
          "from flask import request, send_file",
          ...FLASK_APP,
          "",
          "@app.before_request",
          "def check():",
          ...body,
        ])
      ).filter((entry) => entry.startsWith("middleware"));

    expect(
      await hooks([
        '    if request.headers.get("x-block"):',
        '        return {"error": "blocked"}, 403',
      ]),
    ).toEqual([]);
    expect(
      await hooks([
        '    if request.path == "/legacy":',
        '        return send_file("legacy.html")',
      ]),
    ).toEqual(["middleware * any"]);
  });
});
