import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  copyOfFixture,
  fixture,
  runSuss,
  workspace,
  writePackConfig,
} from "../harness.js";

const FASTAPI_ROUTES = [
  "GET /health",
  "POST /orders",
  "GET /api/items/{item_id}",
  "POST /api/items",
];

const WRAPPED_ROUTES = [
  "GET /todos",
  "POST /todos",
  "GET /users",
  "GET /orders/{order_id}",
  "DELETE /orders/{order_id}",
];

const WRAPPED_ROUTE_FILES = [
  "myapp/routes/todos.py",
  "myapp/routes/users.py",
  "myapp/routes/orders.py",
];

const NAMESPACE_ROUTES = [
  "GET /behaviors/{school_id}",
  "GET /behaviors/{school_id}/{behavior_id}",
  "GET /invoices",
  "GET /invoices/{invoice_id}",
];

describe("read a FastAPI service", () => {
  const out = workspace("fastapi");
  const summariesFile = path.join(out, "shop.json");

  it("works out the directory is Python without being told", () => {
    const extract = runSuss([
      "extract",
      "--dir",
      fixture("python-fastapi"),
      "-f",
      "fastapi",
      "-o",
      summariesFile,
    ]);
    expect(extract.status, extract.stderr).toBe(0);
  });

  it("folds the router prefix and the mount prefix into one path", () => {
    const inspect = runSuss(["inspect", summariesFile]);
    expect(inspect.status, inspect.stderr).toBe(0);

    for (const route of FASTAPI_ROUTES) {
      expect(inspect.stdout).toContain(route);
    }
  });

  it("says which line each route is on, so a person can go there", () => {
    const inspect = runSuss(["inspect", summariesFile]);

    expect(inspect.stdout).toContain(
      "GET /api/items/{item_id}  (fastapi handler | line 20",
    );
    expect(inspect.stdout).toContain(
      "POST /api/items  (fastapi handler | line 25",
    );
  });

  it("abstains on a path it cannot settle, rather than guessing one", () => {
    const inspect = runSuss(["inspect", summariesFile]);

    expect(inspect.stdout).toContain("GET ?");
    expect(inspect.stdout).toContain(
      "The path in this route's decorator is not a string literal",
    );
    expect(inspect.stdout).toContain(
      "The router this route is declared on is mounted with a prefix that is not a string literal",
    );

    expect(inspect.stdout).not.toContain("/reports/summary");
    expect(inspect.stdout).not.toContain("/internal/admin/stats");
  });
});

describe("read a flask-restx service through its own wrapper", () => {
  const project = copyOfFixture("python-webapp");
  const summariesFile = path.join(project, "summaries", "code.json");

  it("reads nothing in the wrapped route files until the wrapper module is named", () => {
    const extract = runSuss(
      [
        "extract",
        "--lang",
        "python",
        "-f",
        "flask-restx",
        "--files",
        ...WRAPPED_ROUTE_FILES,
      ],
      { cwd: project },
    );

    expect(extract.output).toContain("recognized no boundaries");
  });

  it("finds the routes declared on a namespace, with no config, since that half imports flask-restx itself", () => {
    const extract = runSuss(
      ["extract", "--lang", "python", "-f", "flask-restx", "-o", "ns.json"],
      { cwd: project },
    );
    expect(extract.status, extract.stderr).toBe(0);

    const inspect = runSuss(["inspect", path.join(project, "ns.json")]);
    for (const route of NAMESPACE_ROUTES) {
      expect(inspect.stdout).toContain(route);
    }
    for (const route of WRAPPED_ROUTES) {
      expect(inspect.stdout).not.toContain(route);
    }
  });

  it("finds every route once the wrapper is named", () => {
    const config = writePackConfig(project, "flask-restx", {
      wrapperModules: ["myapp.wrappers.restx"],
    });

    const extract = runSuss(
      [
        "extract",
        "--lang",
        "python",
        "-f",
        `flask-restx=${path.basename(config)}`,
        "-o",
        "summaries/code.json",
      ],
      { cwd: project },
    );
    expect(extract.status, extract.stderr).toBe(0);

    const inspect = runSuss(["inspect", summariesFile]);
    expect(inspect.status, inspect.stderr).toBe(0);
    for (const route of [...WRAPPED_ROUTES, ...NAMESPACE_ROUTES]) {
      expect(inspect.stdout).toContain(route);
    }
    expect(inspect.stdout).toContain("11 summaries.");
  });

  it("names no path for a route whose namespace is mounted twice", () => {
    const inspect = runSuss(["inspect", summariesFile]);

    expect(inspect.stdout).toContain("GET ?");
    expect(inspect.stdout).toContain(
      "The router this route is declared on is mounted more than once",
    );
    expect(inspect.stdout).not.toContain("/exports/{export_id}");
  });

  it("canonicalizes a Werkzeug converter into a path parameter", () => {
    const inspect = runSuss(["inspect", summariesFile]);

    expect(inspect.stdout).toContain("/orders/{order_id}");
    expect(inspect.stdout).not.toContain("<int:order_id>");
  });

  it("says which line each route is on, so a person can go there", () => {
    const inspect = runSuss(["inspect", summariesFile]);

    expect(inspect.stdout).toContain(
      "GET /users  (flask-restx handler | line 6",
    );
  });
});
