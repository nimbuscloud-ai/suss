import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  fastapiTestRoutes,
  fastapiTestWrappers,
} from "./__fixtures__/fastapiPattern.js";
import {
  flaskRestxTestRoutes,
  flaskRestxTestWrappers,
} from "./__fixtures__/flaskRestxPattern.js";
import { extractPythonProject, findPythonFiles } from "./project.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type { PythonPack } from "./pack.js";

const FIXTURE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../fixtures",
);

const fastapiLike: PythonPack = {
  name: "fastapi",
  protocol: "http",
  discovery: [
    {
      type: "decoratedFunctionRoute",
      importModule: ["fastapi"],
      routes: fastapiTestRoutes({ get: "GET", post: "POST", delete: "DELETE" }),
      pathParamSyntax: "braces",
      injectedParameterCallees: ["Depends", "Security"],
      defaultStatusCode: 200,
      statusCodeKeyword: "status_code",
      responseStatusCalls: [
        {
          callee: "fastapi.HTTPException",
          statusKeyword: "status_code",
          statusArgument: 0,
        },
      ],
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

const flaskRestxLike: PythonPack = {
  name: "flask-restx",
  protocol: "http",
  discovery: [
    {
      type: "decoratedClassRoute",
      importModule: ["flask_restx"],
      routes: flaskRestxTestRoutes(),
      pathParamSyntax: "flaskConverters",
      defaultStatusCode: 200,
      statusFromReturnedTuple: true,
      responseStatusCalls: [{ callee: "flask.abort", statusArgument: 0 }],
      wrappers: flaskRestxTestWrappers(),
    },
  ],
};

async function extractWritten(files: Record<string, string>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wrappers-"));
  for (const [name, source] of Object.entries(files)) {
    const full = path.join(dir, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, source);
  }
  const { summaries } = await extractPythonProject({
    files: findPythonFiles(dir),
    roots: [dir],
    packs: [fastapiLike],
    workspaceRoot: dir,
  });
  return summaries;
}

async function extract(app: string, pack: PythonPack) {
  const dir = path.join(FIXTURE, app);
  const { summaries } = await extractPythonProject({
    files: findPythonFiles(dir),
    roots: [dir],
    packs: [pack],
    workspaceRoot: dir,
  });
  return summaries;
}

function routeFor(
  summaries: BehavioralSummary[],
  method: string,
  route: string,
): BehavioralSummary {
  const found = summaries.find((one) => {
    const semantics = one.identity.boundaryBinding?.semantics;
    return (
      semantics?.name === "rest" &&
      semantics.method === method &&
      semantics.path === route
    );
  });
  expect(found, `no route for ${method} ${route}`).toBeDefined();
  return found as BehavioralSummary;
}

function statusesOf(summary: BehavioralSummary): number[] {
  return summary.transitions.flatMap((transition) =>
    transition.output.type === "response" &&
    transition.output.statusCode?.type === "literal"
      ? [Number(transition.output.statusCode.value)]
      : [],
  );
}

function wrappersOf(summary: BehavioralSummary): unknown {
  return summary.metadata?.wrappers;
}

function fromOf(summary: BehavioralSummary): (string | undefined)[] {
  return summary.transitions.map(
    (transition) =>
      (transition.metadata?.wrappers as { from?: { name: string } } | undefined)
        ?.from?.name,
  );
}

describe("FastAPI wrappers", () => {
  it("lists the app's dependency, the middleware, the router's and the route's own, then the error handler", async () => {
    const summaries = await extract("wrapped-routes-fastapi", fastapiLike);

    expect(wrappersOf(routeFor(summaries, "POST", "/v1/tenants"))).toEqual({
      applied: [
        { file: "tenants_api/main.py", name: "rate_limit" },
        { file: "tenants_api/dependencies.py", name: "require_caller" },
        { file: "tenants_api/dependencies.py", name: "require_tenant_header" },
        { file: "tenants_api/dependencies.py", name: "require_admin" },
        { file: "tenants_api/main.py", name: "on_error", onThrow: true },
      ],
    });
    const appOnly = {
      applied: [
        { file: "tenants_api/main.py", name: "rate_limit" },
        { file: "tenants_api/dependencies.py", name: "require_caller" },
        { file: "tenants_api/main.py", name: "on_error", onThrow: true },
      ],
    };
    expect(wrappersOf(routeFor(summaries, "GET", "/health"))).toEqual(appOnly);
    expect(wrappersOf(routeFor(summaries, "GET", "/admin/stats"))).toEqual(
      appOnly,
    );
  });

  it("gives each wrapper a summary of its own with the statuses it produces", async () => {
    const summaries = await extract("wrapped-routes-fastapi", fastapiLike);
    const byName = new Map(
      summaries.map((one) => [one.identity.name, statusesOf(one)]),
    );

    expect(byName.get("require_caller")).toEqual([401]);
    expect(byName.get("require_tenant_header")).toEqual([400]);
    expect(byName.get("require_admin")).toEqual([403]);
    expect(byName.get("rate_limit")).toEqual([429]);
    expect(byName.get("on_error")).toEqual([500]);
  });

  it("reports the wrappers' statuses as the route's own, in the order they run", async () => {
    const summaries = await extract("wrapped-routes-fastapi", fastapiLike);

    const read = routeFor(summaries, "GET", "/v1/tenants/{tenant_id}");
    expect(statusesOf(read)).toEqual([429, 401, 400, 404, 200]);
    expect(fromOf(read)).toEqual([
      "rate_limit",
      "require_caller",
      "require_tenant_header",
      undefined,
      undefined,
    ]);

    const create = routeFor(summaries, "POST", "/v1/tenants");
    expect(statusesOf(create)).toEqual([429, 401, 400, 403, 201, 500]);
    expect(fromOf(create)).toEqual([
      "rate_limit",
      "require_caller",
      "require_tenant_header",
      "require_admin",
      undefined,
      undefined,
      "on_error",
    ]);

    const remove = routeFor(summaries, "DELETE", "/v1/tenants/{tenant_id}");
    expect(statusesOf(remove)).toEqual([429, 401, 400, 403, 204]);
  });

  it("lists each dependency's response once, whatever its pass-through branches", async () => {
    const summaries = await extractWritten({
      "app/__init__.py": "",
      "app/main.py": [
        "from fastapi import Depends, FastAPI, HTTPException, Request",
        "",
        "",
        "def tag_request(request: Request):",
        "    if request.headers.get('x-trace') is None:",
        "        counted(request)",
        "    else:",
        "        traced(request)",
        "",
        "",
        "def require_caller(request: Request):",
        "    if request.headers.get('authorization') is None:",
        "        raise HTTPException(status_code=401, detail='unauthorized')",
        "    if request.headers.get('x-tenant') is None:",
        "        load_default(request)",
        "    else:",
        "        load_tenant(request)",
        "",
        "",
        "def counted(request): pass",
        "def traced(request): pass",
        "def load_default(request): pass",
        "def load_tenant(request): pass",
        "",
        "",
        "app = FastAPI(dependencies=[Depends(tag_request), Depends(require_caller)])",
        "",
        "",
        "@app.get('/orders')",
        "def orders(request: Request):",
        "    if request.query_params.get('id') is None:",
        "        raise HTTPException(status_code=404, detail='not found')",
        "    return {'ok': True}",
        "",
      ].join("\n"),
    });

    // Pairing two branching pass-throughs off against the route would
    // give four copies of each of its own two outcomes.
    const orders = routeFor(summaries, "GET", "/orders");
    expect(statusesOf(orders)).toEqual([401, 404, 200]);
    expect(fromOf(orders)).toEqual(["require_caller", undefined, undefined]);
  });

  it("gives a route written in another file on an imported router that router's dependency", async () => {
    const summaries = await extract("wrapped-routes-fastapi", fastapiLike);

    const audit = routeFor(summaries, "GET", "/v1/tenants/{tenant_id}/audit");
    expect(wrappersOf(audit)).toEqual({
      applied: [
        { file: "tenants_api/main.py", name: "rate_limit" },
        { file: "tenants_api/dependencies.py", name: "require_caller" },
        { file: "tenants_api/dependencies.py", name: "require_tenant_header" },
        { file: "tenants_api/main.py", name: "on_error", onThrow: true },
      ],
    });
    expect(statusesOf(audit)).toEqual([429, 401, 400, 200]);
  });

  it("gives a route the dependencies of each include_router above it and of the routers it is mounted onto", async () => {
    const summaries = await extractWritten({
      "app/auth.py": [
        "from fastapi import HTTPException",
        "",
        "Unauthenticated = HTTPException(status_code=401)",
        "",
        "def current_user(token: str):",
        "    if not token:",
        "        raise Unauthenticated",
        "    return token",
        "",
        "def tenant_exists(tenant: str):",
        "    if tenant == 'gone':",
        "        raise HTTPException(status_code=404)",
        "",
      ].join("\n"),
      "app/orders.py": [
        "from fastapi import APIRouter",
        "",
        "router = APIRouter()",
        "",
        '@router.get("/orders")',
        "def list_orders():",
        "    return []",
        "",
      ].join("\n"),
      "app/main.py": [
        "from fastapi import APIRouter, Depends, FastAPI",
        "from app.auth import current_user, tenant_exists",
        "from app.orders import router as orders_router",
        "",
        "app = FastAPI()",
        'tenant_router = APIRouter(prefix="/{tenant}", dependencies=[Depends(tenant_exists)])',
        "tenant_router.include_router(orders_router)",
        "app.include_router(tenant_router, dependencies=[Depends(current_user)])",
        "",
      ].join("\n"),
    });

    const orders = routeFor(summaries, "GET", "/{tenant}/orders");
    expect(wrappersOf(orders)).toEqual({
      applied: [
        { file: "app/auth.py", name: "current_user" },
        { file: "app/auth.py", name: "tenant_exists" },
      ],
    });
    expect(statusesOf(orders)).toEqual([401, 404, 200]);
  });

  it("adds the validation response for a path parameter only a dependency declares", async () => {
    const validating: PythonPack = {
      ...fastapiLike,
      discovery: [
        {
          ...fastapiLike.discovery[0],
          validationFailureStatus: 422,
          parameterSources: { Query: { role: "queryParams" } },
        } as PythonPack["discovery"][number],
      ],
    };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wrappers-"));
    fs.mkdirSync(path.join(dir, "app"));
    fs.writeFileSync(
      path.join(dir, "app/main.py"),
      [
        "from fastapi import APIRouter, Depends, FastAPI, HTTPException, Query",
        "",
        "def tenant_exists(tenant: str):",
        "    if tenant == 'gone':",
        "        raise HTTPException(status_code=404)",
        "",
        "app = FastAPI()",
        'checked = APIRouter(prefix="/{tenant}", dependencies=[Depends(tenant_exists)])',
        'unchecked = APIRouter(prefix="/{region}")',
        "",
        "def paging(page: int = Query(1)):",
        "    return page",
        "",
        '@unchecked.get("/history", dependencies=[Depends(paging)])',
        "def list_history():",
        "    return []",
        "",
        '@checked.get("/orders")',
        "def list_orders():",
        "    return []",
        "",
        '@unchecked.get("/stock")',
        "def list_stock():",
        "    return []",
        "",
        "app.include_router(checked)",
        "app.include_router(unchecked)",
        "",
      ].join("\n"),
    );
    const { summaries } = await extractPythonProject({
      files: findPythonFiles(dir),
      roots: [dir],
      packs: [validating],
      workspaceRoot: dir,
    });

    expect(statusesOf(routeFor(summaries, "GET", "/{tenant}/orders"))).toEqual([
      404, 422, 200,
    ]);
    expect(statusesOf(routeFor(summaries, "GET", "/{region}/stock"))).toEqual([
      200,
    ]);
    expect(statusesOf(routeFor(summaries, "GET", "/{region}/history"))).toEqual(
      [422, 200],
    );
  });

  it("lists the statuses responses= declares on the app, the mounts, the routers and the route", async () => {
    const declaring: PythonPack = {
      ...fastapiLike,
      discovery: [
        {
          ...fastapiLike.discovery[0],
          responsesKeyword: "responses",
        } as PythonPack["discovery"][number],
      ],
    };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wrappers-"));
    fs.writeFileSync(
      path.join(dir, "main.py"),
      [
        "from fastapi import APIRouter, FastAPI",
        "",
        "app = FastAPI(responses={500: {}})",
        "api = APIRouter(responses={400: {}, 401: {}})",
        "orders = APIRouter()",
        "",
        '@orders.get("/orders", responses={409: {}, "default": {}})',
        "def list_orders():",
        "    return []",
        "",
        "api.include_router(orders, responses={403: {}})",
        'app.include_router(api, prefix="/v1")',
        "",
      ].join("\n"),
    );
    const { summaries } = await extractPythonProject({
      files: findPythonFiles(dir),
      roots: [dir],
      packs: [declaring],
      workspaceRoot: dir,
    });

    const route = routeFor(summaries, "GET", "/v1/orders");
    expect(
      (route.metadata?.http as { declaredStatuses?: number[] })
        .declaredStatuses,
    ).toEqual([400, 401, 403, 409, 500]);
  });

  it("gives a router mounted two ways none of the dependencies above it", async () => {
    const summaries = await extractWritten({
      "app/main.py": [
        "from fastapi import APIRouter, Depends, FastAPI, HTTPException",
        "",
        "def current_user(token: str):",
        "    if not token:",
        "        raise HTTPException(status_code=401)",
        "",
        "app = FastAPI()",
        "router = APIRouter()",
        "",
        '@router.get("/orders")',
        "def list_orders():",
        "    return []",
        "",
        'app.include_router(router, prefix="/a", dependencies=[Depends(current_user)])',
        'app.include_router(router, prefix="/b")',
        "",
      ].join("\n"),
    });

    const open = routeFor(summaries, "GET", "/b/orders");
    expect(wrappersOf(open)).toBeUndefined();
  });

  it("reads a dependency written inside Annotated[...] the same as one written as a default", async () => {
    const summaries = await extract("wrapped-routes-fastapi", fastapiLike);

    const remove = routeFor(summaries, "DELETE", "/v1/tenants/{tenant_id}");
    expect(wrappersOf(remove)).toEqual({
      applied: [
        { file: "tenants_api/main.py", name: "rate_limit" },
        { file: "tenants_api/dependencies.py", name: "require_caller" },
        { file: "tenants_api/dependencies.py", name: "require_tenant_header" },
        { file: "tenants_api/dependencies.py", name: "require_admin" },
        { file: "tenants_api/main.py", name: "on_error", onThrow: true },
      ],
    });
  });

  it("reads a dependency behind a type alias to Annotated[...], in this file or an imported one", async () => {
    const summaries = await extractWritten({
      "app/__init__.py": "",
      "app/deps.py": [
        "from typing import Annotated",
        "from fastapi import Depends",
        "",
        "",
        "def current_user():",
        "    return 'u1'",
        "",
        "",
        "CurrentUser = Annotated[str, Depends(current_user)]",
        "",
      ].join("\n"),
      "app/main.py": [
        "from typing import Annotated",
        "from fastapi import Depends, FastAPI",
        "",
        "from app.deps import CurrentUser",
        "",
        "app = FastAPI()",
        "",
        "",
        "def current_team():",
        "    return 't1'",
        "",
        "",
        "CurrentTeam = Annotated[str, Depends(current_team)]",
        "",
        "",
        '@app.get("/orders")',
        "def list_orders(user: CurrentUser, team: CurrentTeam):",
        "    return []",
        "",
      ].join("\n"),
    });

    const orders = routeFor(summaries, "GET", "/orders");
    expect(wrappersOf(orders)).toEqual({
      applied: [
        { file: "app/deps.py", name: "current_user" },
        { file: "app/main.py", name: "current_team" },
      ],
    });
  });

  it("registers nothing off an app a factory in another module builds", async () => {
    const summaries = await extractWritten({
      "app/__init__.py": "",
      "app/factory.py": [
        "from fastapi import Depends, FastAPI",
        "",
        "",
        "def tag_request(): pass",
        "",
        "",
        "def create_app():",
        "    return FastAPI(dependencies=[Depends(tag_request)])",
        "",
      ].join("\n"),
      "app/main.py": [
        "from app.factory import create_app",
        "",
        "app = create_app()",
        "",
        "",
        "@app.get('/orders')",
        "def orders():",
        "    return {'ok': True}",
        "",
      ].join("\n"),
    });

    // The dependency list is written on the call, and that call is in
    // the other file.
    expect(wrappersOf(routeFor(summaries, "GET", "/orders"))).toBeUndefined();
  });

  it("registers no middleware on an app another file builds, whether imported or handed to a function", async () => {
    const summaries = await extractWritten({
      "app/__init__.py": "",
      "app/handlers.py": [
        "from fastapi import FastAPI",
        "",
        "",
        "def register(app: FastAPI):",
        "    @app.exception_handler(ValueError)",
        "    async def handed(request, exc):",
        "        return None",
        "",
      ].join("\n"),
      "app/hooks.py": [
        "from app.main import app",
        "",
        "",
        "@app.middleware('http')",
        "async def imported(request, call_next):",
        "    return await call_next(request)",
        "",
      ].join("\n"),
      "app/main.py": [
        "from fastapi import FastAPI",
        "from app.handlers import register",
        "",
        "app = FastAPI()",
        "register(app)",
        "",
        "",
        "@app.get('/orders')",
        "def orders():",
        "    return {'ok': True}",
        "",
      ].join("\n"),
    });

    expect(wrappersOf(routeFor(summaries, "GET", "/orders"))).toBeUndefined();
    expect(summaries.map((one) => one.identity.name)).not.toContain("handed");
  });

  it("reads a list's Depends through the library's import, under any name, and a dependency written alone", async () => {
    const summaries = await extractWritten({
      "app/main.py": [
        "from fastapi import FastAPI, Depends as Needs",
        "from other.lib import Depends",
        "",
        "",
        "def tag_request():",
        "    return None",
        "",
        "",
        "def unrelated():",
        "    return None",
        "",
        "",
        "app = FastAPI(dependencies=[Needs(tag_request), Depends(unrelated)])",
        "",
        "",
        "@app.get('/orders', dependencies=Needs(tag_request))",
        "def orders():",
        "    return {'ok': True}",
        "",
      ].join("\n"),
    });

    expect(wrappersOf(routeFor(summaries, "GET", "/orders"))).toEqual({
      applied: [{ file: "app/main.py", name: "tag_request" }],
    });
  });
});

describe("decorators written on a route's function", () => {
  const ROUTES = [
    "from functools import wraps",
    "from fastapi import FastAPI, HTTPException",
    "from slowapi import Limiter",
    "",
    "app = FastAPI()",
    "limiter = Limiter(key_func=lambda request: 'caller')",
    "",
    "def require_admin(fn):",
    "    @wraps(fn)",
    "    async def wrapper(*args, **kwargs):",
    "        if kwargs.get('token') != 'admin':",
    "            raise HTTPException(status_code=403)",
    "        return await fn(*args, **kwargs)",
    "    return wrapper",
    "",
    "@limiter.limit('5/minute')",
    "@app.get('/above')",
    "async def above(token: str):",
    "    return {'ok': True}",
    "",
    "@app.get('/limited')",
    "@limiter.limit('5/minute')",
    "async def limited(token: str):",
    "    return {'ok': True}",
    "",
    "@app.get('/admin')",
    "@require_admin",
    "async def admin(token: str):",
    "    return {'admin': True}",
    "",
  ].join("\n");

  it("records a library's decorator below the route's as a layer the run did not read", async () => {
    const summaries = await extractWritten({ "app/main.py": ROUTES });

    expect(wrappersOf(routeFor(summaries, "GET", "/limited"))).toEqual({
      applied: [{ file: "slowapi", name: "limiter.limit" }],
    });
  });

  it("composes the closure the project's own decorator hands back into the route", async () => {
    const summaries = await extractWritten({ "app/main.py": ROUTES });
    const admin = routeFor(summaries, "GET", "/admin");

    expect(wrappersOf(admin)).toEqual({
      applied: [{ file: "app/main.py", name: "require_admin(fn)" }],
    });
    expect(statusesOf(admin)).toEqual([403, 200]);
    expect(fromOf(admin)).toEqual(["require_admin(fn)", undefined]);
    const closure = summaries.find(
      (one) => one.identity.name === "require_admin(fn)",
    );
    expect(
      closure?.transitions.map((transition) => transition.output),
    ).toContainEqual({ type: "delegate", to: "fn" });
  });

  it("records a project decorator whose closure keeps going after the call with no summary behind it", async () => {
    const summaries = await extractWritten({
      "app/main.py": [
        "from fastapi import FastAPI",
        "",
        "app = FastAPI()",
        "",
        "def logged(fn):",
        "    async def wrapper(*args, **kwargs):",
        "        result = await fn(*args, **kwargs)",
        "        if result is None:",
        "            return {'missing': True}",
        "        return result",
        "    return wrapper",
        "",
        "@app.get('/logged')",
        "@logged",
        "async def logged_route():",
        "    return {'ok': True}",
        "",
      ].join("\n"),
    });

    expect(wrappersOf(routeFor(summaries, "GET", "/logged"))).toEqual({
      applied: [{ file: "app/main.py", name: "logged(fn)" }],
    });
    expect(summaries.some((one) => one.identity.name === "logged(fn)")).toBe(
      false,
    );
  });

  it("records a project decorator it cannot read through with no summary behind it", async () => {
    const summaries = await extractWritten({
      "app/main.py": [
        "import functools",
        "from fastapi import FastAPI",
        "",
        "app = FastAPI()",
        "",
        "def traced(fn):",
        "    return functools.partial(fn)",
        "",
        "REGISTRY = []",
        "",
        "def registered(fn):",
        "    REGISTRY.append(fn)",
        "    return fn",
        "",
        "@app.get('/traced')",
        "@traced",
        "async def traced_route():",
        "    return {'ok': True}",
        "",
        "@app.get('/registered')",
        "@registered",
        "async def registered_route():",
        "    return {'ok': True}",
        "",
      ].join("\n"),
    });

    expect(wrappersOf(routeFor(summaries, "GET", "/traced"))).toEqual({
      applied: [{ file: "app/main.py", name: "traced(fn)" }],
    });
    expect(wrappersOf(routeFor(summaries, "GET", "/registered"))).toEqual({
      applied: [{ file: "app/main.py", name: "registered(fn)" }],
    });
    expect(summaries.some((one) => one.identity.name === "traced(fn)")).toBe(
      false,
    );
  });

  it("leaves out a decorator above the route's, which wraps the function after the library has it", async () => {
    const summaries = await extractWritten({ "app/main.py": ROUTES });

    expect(wrappersOf(routeFor(summaries, "GET", "/above"))).toBeUndefined();
  });
});

describe("flask-restx wrappers", () => {
  it("lists the app's before_request hook and the API's error handler", async () => {
    const summaries = await extract("wrapped-routes-flask", flaskRestxLike);

    expect(wrappersOf(routeFor(summaries, "POST", "/v1/tenants"))).toEqual({
      applied: [
        { file: "tenants_api/main.py", name: "require_caller" },
        { file: "tenants_api/main.py", name: "on_error", onThrow: true },
      ],
    });
  });

  it("reports the hook's 401 and the handler's 500 as the resource's own", async () => {
    const summaries = await extract("wrapped-routes-flask", flaskRestxLike);
    const byName = new Map(
      summaries.map((one) => [one.identity.name, statusesOf(one)]),
    );
    expect(byName.get("require_caller")).toEqual([401]);
    expect(byName.get("on_error")).toEqual([500]);

    expect(
      statusesOf(routeFor(summaries, "GET", "/v1/tenants/{tenant_id}")),
    ).toEqual([401, 404, 200]);
    expect(statusesOf(routeFor(summaries, "POST", "/v1/tenants"))).toEqual([
      401, 201, 500,
    ]);
  });
});
