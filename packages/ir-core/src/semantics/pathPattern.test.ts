/**
 * Route paths with holes that take some number of segments, and with
 * set pieces. What two such paths have in common decides which buckets
 * the pairing pass compares, so each range and each set spelling is
 * pinned down here against the paths it meets and the ones it does not.
 */

import { describe, expect, it } from "vitest";

import {
  compareRanks,
  pathSpansShapes,
  pathsMeet,
  patternAdmits,
  requestRank,
} from "./pathPattern.js";

describe("pathsMeet", () => {
  it("meets a path with a hole of one segment only on the same shape", () => {
    expect(pathsMeet("/orders/{id}", "/orders/{orderId}")).toBe(true);
    expect(pathsMeet("/orders/{id}", "/orders/17")).toBe(true);
    expect(pathsMeet("/orders/{id}", "/orders/17/lines")).toBe(false);
    expect(pathsMeet("/orders/{id}", "/orders")).toBe(false);
  });

  it("lets an optional hole absorb zero or one segment", () => {
    const declared = "/api/{version}/{tenant?}/orders/{id}";
    expect(pathsMeet(declared, "/api/v1/orders/17")).toBe(true);
    expect(pathsMeet(declared, "/api/v1/acme/orders/17")).toBe(true);
    expect(pathsMeet(declared, "/api/v1/acme/eu/orders/17")).toBe(false);
    expect(pathsMeet(declared, "/api/v1/orders/{id}")).toBe(true);
  });

  it("lets a plus hole absorb one or more segments", () => {
    expect(pathsMeet("/files/{rest+}", "/files")).toBe(false);
    expect(pathsMeet("/files/{rest+}", "/files/a")).toBe(true);
    expect(pathsMeet("/files/{rest+}", "/files/a/b/c")).toBe(true);
    expect(pathsMeet("/files/{rest+}/raw", "/files/a/b/raw")).toBe(true);
    expect(pathsMeet("/files/{rest+}/raw", "/files/raw")).toBe(false);
  });

  it("lets a star hole and a bare star absorb zero or more segments", () => {
    expect(pathsMeet("/files/{rest*}", "/files")).toBe(true);
    expect(pathsMeet("/files/{rest*}", "/files/a/b")).toBe(true);
    expect(pathsMeet("/api/orders/*", "/api/orders")).toBe(true);
    expect(pathsMeet("/api/orders/*", "/api/orders/{id}/lines")).toBe(true);
    expect(pathsMeet("/api/orders/*", "/api/users/{id}")).toBe(false);
  });

  it("reads a set piece as any one of its options, a slash included", () => {
    expect(pathsMeet("/api/(v1|v2)/orders", "/api/v2/orders")).toBe(true);
    expect(pathsMeet("/api/(v1|v2)/orders", "/api/v3/orders")).toBe(false);
    expect(pathsMeet("/api(/v2|)/orders", "/api/orders")).toBe(true);
    expect(pathsMeet("/api(/v2|)/orders", "/api/v2/orders")).toBe(true);
    expect(pathsMeet("/api(/v2|)/orders", "/api/v1/orders")).toBe(false);
  });

  it("compares a segment with text around its hole by the text", () => {
    expect(pathsMeet("/files/{name}.json", "/files/report.json")).toBe(true);
    expect(pathsMeet("/files/{name}.json", "/files/report.csv")).toBe(false);
    expect(pathsMeet("/files/{name}.json", "/files/{file}.json")).toBe(true);
    expect(pathsMeet("/files/{name}.json", "/files/{file}")).toBe(true);
  });

  it("lets a star or optional hole inside a segment take no text at all", () => {
    expect(pathsMeet("/files/report{query*}", "/files/report")).toBe(true);
    expect(pathsMeet("/files/report{query?}", "/files/report")).toBe(true);
    expect(pathsMeet("/files/report{id}", "/files/report")).toBe(false);
  });

  it("treats the root as a path with no segments", () => {
    expect(pathsMeet("/", "/")).toBe(true);
    expect(pathsMeet("/", "/{rest*}")).toBe(true);
    expect(pathsMeet("/", "/{id}")).toBe(false);
  });

  it("reads a hole before the first slash as the origin, which takes no segment", () => {
    const client = "{baseUrl}/links/count{value*}";
    expect(pathsMeet(client, "/wellknown/{domain}/{file}")).toBe(false);
    expect(pathsMeet(client, "/links/count")).toBe(true);
    expect(pathsMeet("{value*}/companion/desktop", "/workflows/{a}/{b}")).toBe(
      false,
    );
    expect(pathsMeet("{value*}/companion/desktop", "/companion/desktop")).toBe(
      true,
    );
    expect(pathsMeet("/{tenant}/orders", "/acme/orders")).toBe(true);
  });

  it("keeps a path with more sets than it can expand, with the sets as one hole", () => {
    const sets = Array.from({ length: 7 }, () => "(a|b)").join("/");
    expect(pathsMeet(`/${sets}`, `/${"a/".repeat(6)}a`)).toBe(true);
    expect(pathsMeet(`/${sets}`, `/${"a/".repeat(6)}z`)).toBe(true);
    expect(pathsMeet(`/${sets}`, "/a")).toBe(false);
  });
});

describe("patternAdmits", () => {
  it("reads every segment of the request as text, a hole included", () => {
    expect(patternAdmits("/api/{rest*}", "/api/orders/{id}")).toBe(true);
    expect(patternAdmits("/api/orders/{id}", "/api/{rest*}")).toBe(false);
    expect(patternAdmits("/api/orders/{id}", "/api/orders/{id}")).toBe(true);
  });
});

describe("pathSpansShapes", () => {
  it("is true for a range, a set, or a bare star, and false otherwise", () => {
    expect(pathSpansShapes("/orders/{id}")).toBe(false);
    expect(pathSpansShapes("/files/{name}.json")).toBe(false);
    expect(pathSpansShapes("/orders/{id?}")).toBe(true);
    expect(pathSpansShapes("/files/{rest+}")).toBe(true);
    expect(pathSpansShapes("/api/(v1|v2)/orders")).toBe(true);
    expect(pathSpansShapes("/api/orders/*")).toBe(true);
    expect(pathSpansShapes("*")).toBe(true);
  });
});

describe("requestRank", () => {
  const compareFor = (request: string, a: string, b: string): number =>
    compareRanks(requestRank(a, request) ?? [], requestRank(b, request) ?? []);

  it("ranks the route that spells out more of the request higher", () => {
    expect(compareFor("/users/me", "/users/me", "/users/{id}")).toBeGreaterThan(
      0,
    );
    expect(
      compareFor("/api/orders/7", "/api/orders/*", "/api/{a}/{b}"),
    ).toBeGreaterThan(0);
  });

  it("ranks the route that lets fewer segments vary in number higher", () => {
    expect(
      compareFor(
        "/api/v1/orders/7",
        "/api/{v}/orders/{id}",
        "/api/{v}/{t?}/orders/{id}",
      ),
    ).toBeGreaterThan(0);
    expect(
      compareFor("/api/orders/7", "/api/orders/{id}", "/api/orders/*"),
    ).toBeGreaterThan(0);
  });

  it("ranks a segment whose pattern matches above a bare hole", () => {
    expect(
      compareFor("/files/a.json", "/files/{name}.json", "/files/{name}"),
    ).toBeGreaterThan(0);
  });

  it("ranks a pattern that spells more of the segment higher", () => {
    expect(
      compareFor(
        "/t/{id}/recover.json",
        "/t/{topic_id}/recover(|.{format})",
        "/t/{slug}/{topic_id}(|.{format})",
      ),
    ).toBeGreaterThan(0);
  });

  it("ranks a route by the reading that fits the request", () => {
    expect(compareFor("/api/orders", "/api/orders", "/api(/v2|)/orders")).toBe(
      0,
    );
    expect(
      compareFor("/api/v1/orders", "/api/(v1|v2)/orders", "/api/{v}/orders"),
    ).toBeGreaterThan(0);
  });

  it("ranks two routes of one shape equal", () => {
    expect(compareFor("/orders/{x}", "/orders/{id}", "/orders/{orderId}")).toBe(
      0,
    );
  });

  it("gives no rank to a route that spells a word where the request has a hole", () => {
    expect(requestRank("/users/settings", "/users/{userId}")).toBeNull();
    expect(requestRank("/users/{id}", "/users/{userId}")).not.toBeNull();
  });
});
