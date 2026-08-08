/**
 * The REST protocol's request matching: whether a declared route
 * handles a concrete method and path. The flow walk asks this through
 * the registry, so what a route admits is pinned down here, in the
 * protocol's own module, and nowhere else.
 */

import { describe, expect, it } from "vitest";

import { servesRequest } from "../boundaryKey.js";
import { restSemantics, routePathAdmits } from "./rest.js";

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
      semantics: { name: "message-bus", messageBus: "sqs", channel: null },
      recognition: "test",
    };
    expect(servesRequest(binding, "GET", "/orders/7")).toBeNull();
  });
});
