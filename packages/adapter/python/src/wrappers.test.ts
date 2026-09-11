import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

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
      verbAttributeNames: { get: "GET", post: "POST", delete: "DELETE" },
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
      routerComposition: {
        routerConstructorName: "APIRouter",
        includeMethodName: "include_router",
        routerKeyword: "router",
        prefixKeyword: "prefix",
      },
      wrappers: [
        {
          type: "dependency",
          callees: ["Depends", "Security"],
          keyword: "dependencies",
          registrars: [
            { constructorName: "FastAPI", covers: "everyRoute" },
            { constructorName: "APIRouter", covers: "ownRoutes" },
          ],
        },
        {
          type: "decoratedWrapper",
          attribute: "middleware",
          registrars: [{ constructorName: "FastAPI", covers: "everyRoute" }],
          continuationParam: 1,
        },
        {
          type: "decoratedWrapper",
          attribute: "exception_handler",
          registrars: [{ constructorName: "FastAPI", covers: "everyRoute" }],
          throwParam: 1,
        },
      ],
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
      decoratorName: "route",
      verbMethodNames: { get: "GET", post: "POST" },
      pathParamSyntax: "flaskConverters",
      defaultStatusCode: 200,
      statusFromReturnedTuple: true,
      responseStatusCalls: [{ callee: "flask.abort", statusArgument: 0 }],
      routerComposition: {
        routerConstructorName: "Namespace",
        includeMethodName: "add_namespace",
        prefixKeyword: "path",
        mountPrefixEffect: "replaces",
        constructorPrefixRequired: true,
      },
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
            { constructorName: "Api", covers: "everyRoute" },
            { constructorName: "Namespace", covers: "ownRoutes" },
          ],
          throwParam: 0,
        },
      ],
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
