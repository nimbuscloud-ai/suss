/**
 * The REST protocol's request matching: whether a declared route
 * handles a concrete method and path. The flow walk asks this through
 * the registry, so what a route admits is pinned down here, in the
 * protocol's own module, and nowhere else.
 */

import { describe, expect, it } from "vitest";

import { servesRequest, withinScope } from "../boundaryKey.js";
import { referenceName } from "../boundaryName.js";
import { restSemantics, routePathAdmits } from "./rest.js";

import type { Deployment } from "../deployment.js";
import type { BoundaryBinding } from "../index.js";

describe("routePathAdmits", () => {
  it("admits an exact path and refuses a different one", () => {
    expect(routePathAdmits("/api/orders/_health", "/api/orders/_health")).toBe(
      true,
    );
    expect(routePathAdmits("/api/orders/_health", "/api/orders/123")).toBe(
      false,
    );
  });

  it("reads a param as exactly one segment, in either spelling", () => {
    expect(routePathAdmits("/orders/{id}", "/orders/123")).toBe(true);
    expect(routePathAdmits("/orders/:id", "/orders/123")).toBe(true);
    expect(routePathAdmits("/orders/{id}", "/orders/123/lines")).toBe(false);
    expect(routePathAdmits("/orders/{id}", "/orders/")).toBe(false);
  });

  it("reads a star across segments and as empty, Express 4's rule", () => {
    expect(routePathAdmits("/api/orders/*", "/api/orders/123")).toBe(true);
    expect(routePathAdmits("/api/orders/*", "/api/orders/a/b")).toBe(true);
    expect(routePathAdmits("/api/orders/*", "/api/other/123")).toBe(false);
  });

  it("compares on the normalized forms: trailing slash stripped, static segments case-folded", () => {
    expect(routePathAdmits("/Orders/{id}/", "/orders/123")).toBe(true);
    expect(routePathAdmits("/orders", "/ORDERS/")).toBe(true);
  });
});

describe("restSemantics servesRequest", () => {
  const serves = restSemantics.behavior.servesRequest;
  if (serves === undefined) {
    throw new Error("rest must define servesRequest");
  }

  it("answers with its own match when both halves are named", () => {
    const route = { name: "rest" as const, method: "GET", path: "/orders" };
    expect(serves(route, "GET", "/orders")).toBe("match");
    expect(serves(route, "POST", "/orders")).toBe("nomatch");
    expect(serves(route, "GET", "/other")).toBe("nomatch");
  });

  it("lets an every-method route answer any method", () => {
    const route = { name: "rest" as const, method: "*", path: "/orders/*" };
    expect(serves(route, "DELETE", "/orders/9")).toBe("match");
  });

  it("abstains when either half is unnamed, never refusing", () => {
    expect(
      serves({ name: "rest", method: null, path: "/orders" }, "GET", "/orders"),
    ).toBe("unknown");
    expect(
      serves({ name: "rest", method: "GET", path: null }, "GET", "/orders"),
    ).toBe("unknown");
  });
});

describe("withinScope through the registry", () => {
  const scoped = (path: string | null): BoundaryBinding => ({
    transport: "http",
    semantics: { name: "rest", method: "GET", path },
    recognition: "test",
  });

  it("puts a route the pattern admits inside it, and leaves the rest out", () => {
    expect(withinScope(scoped("/v1/tenants/{id}"), "/v1/*")).toBe(true);
    expect(withinScope(scoped("/health"), "/v1/*")).toBe(false);
    expect(withinScope(scoped(null), "/v1/*")).toBe(false);
  });

  it("leaves a protocol no pattern addresses out of every scope", () => {
    const binding: BoundaryBinding = {
      transport: "queue",
      semantics: { name: "message-bus", messageBus: "aws_sqs", channel: null },
      recognition: "test",
    };
    expect(withinScope(binding, "/v1/*")).toBe(false);
  });
});

describe("servesRequest through the registry", () => {
  it("dispatches a rest binding to the rest matcher", () => {
    const binding: BoundaryBinding = {
      transport: "http",
      semantics: { name: "rest", method: "GET", path: "/orders/{id}" },
      recognition: "test",
    };
    expect(servesRequest(binding, "GET", "/orders/7")).toBe("match");
  });

  it("answers null for a protocol without request matching, apart from an abstaining one", () => {
    const binding: BoundaryBinding = {
      transport: "queue",
      semantics: { name: "message-bus", messageBus: "aws_sqs", channel: null },
      recognition: "test",
    };
    expect(servesRequest(binding, "GET", "/orders/7")).toBeNull();
  });
});

describe("restSemantics groundName", () => {
  const ground = restSemantics.behavior.groundName;
  if (ground === undefined) {
    throw new Error("rest must define groundName");
  }

  const route = (path: string | null) => ({
    name: "rest" as const,
    method: "GET",
    path,
  });
  // Which variable a dotted reference asks about is the deployment
  // reader's rule, so these stand in for it by taking the whole path.
  const sets = (values: Record<string, string>): Deployment => ({
    variableFor: (reference) => referenceName(reference),
    setTo: (reference) =>
      values[[reference.root, ...reference.fields].join(".")] ?? null,
    pointsAt: () => null,
  });

  it("takes the origin off when the base URL is one", () => {
    expect(
      ground(route("{API_BASE}/orders"), sets({ API_BASE: "http://backend" })),
    ).toEqual({ name: "rest", method: "GET", path: "/orders" });
  });

  it("keeps the prefix when the base URL is a path", () => {
    // The source cannot tell these two apart, which is why the adapter
    // leaves the hole in. Only the deployment says which one it is.
    expect(
      ground(route("{API_BASE}/orders"), sets({ API_BASE: "/api/v2" })),
    ).toEqual({ name: "rest", method: "GET", path: "/api/v2/orders" });
  });

  it("hands the whole reference over, dots and all", () => {
    expect(
      ground(
        route("{env.API_BASE}/orders"),
        sets({ "env.API_BASE": "http://backend" }),
      ),
    ).toEqual({ name: "rest", method: "GET", path: "/orders" });
  });

  it("gives back the root for a base URL with nothing after it", () => {
    expect(
      ground(route("{API_BASE}"), sets({ API_BASE: "http://backend" })),
    ).toEqual({ name: "rest", method: "GET", path: "/" });
  });

  it("leaves the path alone when nothing sets the variable", () => {
    expect(ground(route("{API_BASE}/orders"), sets({}))).toBeNull();
  });

  it("leaves a hole that is not at the front alone", () => {
    // `/orders/{id}` is a route parameter, and putting a deployed value
    // into one would be wrong.
    expect(ground(route("/orders/{id}"), sets({ id: "9" }))).toBeNull();
  });

  it("leaves a path the source never gave alone", () => {
    expect(
      ground(route(null), sets({ API_BASE: "http://backend" })),
    ).toBeNull();
  });
});
