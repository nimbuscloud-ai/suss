// A person points suss at a Python service and reads back its routes.
//
// Two shapes, because the two packs read Python differently. FastAPI
// puts the path on a decorator and can carry two prefixes above it,
// one from the router and one from the mount. flask-restx puts it on a
// class decorator that most services re-export through a wrapper of
// their own, which is the only thing the pack needs told.
//
// The bar is the one the production measurement failed: every route
// recovered, and every path right. A pack that finds five routes and
// spells four of them wrong is worse than one that finds none, because
// the wrong four pair against nothing and read as drift.

import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  copyOfFixture,
  fixture,
  runSuss,
  workspace,
  writePackConfig,
} from "../harness.js";

/** Every route fixtures/python-fastapi declares, once the prefixes are folded in. */
const FASTAPI_ROUTES = [
  "GET /health",
  "POST /orders",
  "GET /api/items/{item_id}",
  "POST /api/items",
];

/** Every route fixtures/python-webapp declares through its own wrapper. */
const FLASK_RESTX_ROUTES = [
  "GET /todos",
  "POST /todos",
  "GET /users",
  "GET /orders/{order_id}",
  "DELETE /orders/{order_id}",
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

    // /items on the router, /api on the mount, and neither prefix is
    // written in the file the route lives in.
    for (const route of FASTAPI_ROUTES) {
      expect(inspect.stdout).toContain(route);
    }
  });

  it("says which line each route is on, so a person can go there", () => {
    const inspect = runSuss(["inspect", summariesFile]);

    // shop/routers/items.py is 26 lines and declares its two routes on
    // lines 20 and 25. The adapter recorded a byte offset here until
    // #215, so the guide had to print `line 708` on a 32-line file and
    // say the number was wrong.
    expect(inspect.stdout).toContain(
      "GET /api/items/{item_id}  (fastapi handler | line 20",
    );
    expect(inspect.stdout).toContain(
      "POST /api/items  (fastapi handler | line 25",
    );
  });

  it("abstains on a path it cannot settle, rather than guessing one", () => {
    const inspect = runSuss(["inspect", summariesFile]);

    // `@app.get("/reports/" + REPORT_SECTION)` and a mount whose
    // prefix is a function call. Both come back with no path, and a
    // sentence saying which of the two happened.
    expect(inspect.stdout).toContain("GET ?");
    expect(inspect.stdout).toContain(
      "The path in this route's decorator is not a string literal",
    );
    expect(inspect.stdout).toContain(
      "The router this route is declared on is mounted with a prefix that is not a string literal",
    );

    // A guessed path is worse than none: it pairs against a client
    // calling the guess and reports drift on a route nobody has.
    expect(inspect.stdout).not.toContain("/reports/summary");
    expect(inspect.stdout).not.toContain("/internal/admin/stats");
  });
});

describe("read a flask-restx service through its own wrapper", () => {
  const project = copyOfFixture("python-webapp");
  const summariesFile = path.join(project, "summaries", "code.json");

  it("reads nothing until the wrapper module is named", () => {
    const extract = runSuss(
      ["extract", "--lang", "python", "-f", "flask-restx"],
      { cwd: project },
    );

    // Not an error: the pack read the files and recognized nothing in
    // them. What matters is that it says so instead of printing an
    // empty array and stopping.
    expect(extract.output).toContain("recognized no boundaries");
  });

  it("finds every route once it is", () => {
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
    for (const route of FLASK_RESTX_ROUTES) {
      expect(inspect.stdout).toContain(route);
    }
    expect(inspect.stdout).toContain("5 summaries.");
  });

  it("canonicalizes a Werkzeug converter into a path parameter", () => {
    const inspect = runSuss(["inspect", summariesFile]);

    // The source writes /orders/<int:order_id>. A client calling this
    // route writes /orders/123, and the two only pair if the converter
    // is read away.
    expect(inspect.stdout).toContain("/orders/{order_id}");
    expect(inspect.stdout).not.toContain("<int:order_id>");
  });

  it("says which line each route is on, so a person can go there", () => {
    const inspect = runSuss(["inspect", summariesFile]);

    // myapp/routes/users.py is 7 lines long and declares one route, on
    // line 6. The adapter recorded a byte offset here until #215, so
    // this printed `line 78` and pointed into the middle of a token.
    expect(inspect.stdout).toContain(
      "GET /users  (flask-restx handler | line 6",
    );
  });
});
