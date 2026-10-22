import { describe, expect, it } from "vitest";

import { extractEdges, targetKey } from "./edges.js";

import type { AttributeValue, Span, SpanKind } from "./spans.js";

let nextId = 0;

function span(
  name: string,
  kind: SpanKind,
  parent: Span | null,
  attributes: Record<string, AttributeValue>,
  trace = "t1",
): Span {
  nextId += 1;
  return {
    traceId: trace,
    spanId: `s${nextId}`,
    parentSpanId: parent?.spanId ?? null,
    name,
    kind,
    scope: "test",
    attributes,
    resource: { "process.command_args": "node api/run.js start" },
  };
}

function request(
  method: string,
  route: string,
  path: string,
  trace = "t1",
): Span {
  return span(
    `${method} ${route}`,
    "server",
    null,
    { "http.request.method": method, "http.route": route, "url.path": path },
    trace,
  );
}

describe("extractEdges", () => {
  it("attributes a query under middleware to the request's route", () => {
    const server = request("GET", "/users/:id", "/users/7");
    const middleware = span("middleware - auth", "internal", server, {});
    const query = span("select", "client", middleware, {
      "db.system.name": "postgresql",
      "db.collection.name": "public.users",
    });

    const { edges } = extractEdges([server, middleware, query]);

    expect(
      edges.map(
        (edge) =>
          `${edge.entry.method} ${edge.entry.route} -> ${targetKey(edge.target)}`,
      ),
    ).toEqual(["GET /users/:id -> postgresql:users"]);
  });

  it("reads every table a statement joins, with Python's bind spelling", () => {
    const server = request("GET", "/orders", "/orders");
    const query = span("SELECT", "client", server, {
      "db.system": "postgresql",
      "db.statement":
        "SELECT o.id FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.id = %(id_1)s",
    });

    const tables = extractEdges([server, query]).edges.map((edge) =>
      targetKey(edge.target),
    );

    expect(tables.sort()).toEqual([
      "postgresql:customers",
      "postgresql:orders",
    ]);
  });

  it("marks a table the request path gives", () => {
    const server = request("GET", "/items/:collection", "/items/articles");
    const query = span("select", "client", server, {
      "db.system.name": "sqlite",
      "db.collection.name": "articles",
    });

    const [edge] = extractEdges([server, query]).edges;

    expect(edge?.tableFromRequest).toBe(true);
  });

  it("sets aside catalog reads, statements with no table and reaches outside a request", () => {
    const server = request("GET", "/fields", "/fields");
    const catalog = span("select", "client", server, {
      "db.system.name": "sqlite",
      "db.collection.name": "sqlite_master",
    });
    const pragma = span("raw", "client", server, {
      "db.system.name": "sqlite",
      "db.query.text": "PRAGMA table_info(`users`)",
    });
    const startup = span("select", "client", null, {
      "db.system.name": "sqlite",
      "db.collection.name": "settings",
    });

    const { edges, setAside } = extractEdges([
      server,
      catalog,
      pragma,
      startup,
    ]);

    expect(edges).toEqual([]);
    expect(setAside.map((one) => one.reason).sort()).toEqual([
      "a reach outside any request",
      "a read of the sqlite catalog",
      "a sqlite statement with no table in it",
    ]);
  });

  it("reads an outbound request and a message send", () => {
    const server = request("POST", "/checkout", "/checkout");
    const outbound = span("GET", "client", server, {
      "http.request.method": "GET",
      "url.full": "https://payments.example.com/v1/charges/42",
      "url.template": "/v1/charges/{id}",
    });
    const send = span("publish", "producer", server, {
      "messaging.system": "kafka",
      "messaging.destination.name": "orders",
    });

    const targets = extractEdges([server, outbound, send]).edges.map((edge) =>
      targetKey(edge.target),
    );

    expect(targets).toEqual([
      "GET payments.example.com/v1/charges/{id}",
      "kafka:orders",
    ]);
  });

  it("attributes a reach to the nearest request, not the one that called it", () => {
    const outer = request("GET", "/a", "/a", "t2");
    const call = span(
      "GET",
      "client",
      outer,
      {
        "http.request.method": "GET",
        "url.full": "http://127.0.0.1:9000/b",
      },
      "t2",
    );
    const inner = {
      ...request("GET", "/b", "/b", "t2"),
      parentSpanId: call.spanId,
    };
    const query = span(
      "select",
      "client",
      inner,
      {
        "db.system.name": "sqlite",
        "db.collection.name": "bees",
      },
      "t2",
    );

    const edges = extractEdges([outer, call, inner, query]).edges.map(
      (edge) => `${edge.entry.route} -> ${targetKey(edge.target)}`,
    );

    expect(edges.sort()).toEqual([
      "/a -> GET 127.0.0.1/b",
      "/b -> sqlite:bees",
    ]);
  });

  it("drops Rails' optional format and keeps the requests a resource filter allows", () => {
    const rails = request("GET", "/stories/:id(.:format)", "/stories/abc");
    const other = {
      ...request("GET", "/health", "/health"),
      resource: { "process.command_args": "node license.js" },
    };

    const { routes } = extractEdges([rails, other], {
      resourceFilters: [{ key: "process.command_args", text: "api/run.js" }],
    });

    expect(routes.map((route) => route.entry.route)).toEqual(["/stories/:id"]);
  });
});
