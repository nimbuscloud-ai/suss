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
  pathSpecificity,
  pathsMeet,
  patternAdmits,
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

  it("treats the root as a path with no segments", () => {
    expect(pathsMeet("/", "/")).toBe(true);
    expect(pathsMeet("/", "/{rest*}")).toBe(true);
    expect(pathsMeet("/", "/{id}")).toBe(false);
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

describe("pathSpecificity", () => {
  const outranks = (a: string, b: string): boolean =>
    compareRanks(pathSpecificity(a), pathSpecificity(b)) > 0;

  it("ranks the path with more fixed segments higher", () => {
    expect(outranks("/users/me", "/users/{id}")).toBe(true);
    expect(outranks("/api/orders/*", "/api/{a}/{b}")).toBe(true);
  });

  it("ranks the path that lets fewer segments vary in number higher", () => {
    expect(outranks("/api/{v}/orders/{id}", "/api/{v}/{t?}/orders/{id}")).toBe(
      true,
    );
    expect(outranks("/api/orders/{id}", "/api/orders/*")).toBe(true);
  });

  it("ranks a segment with text around its hole above a bare hole", () => {
    expect(outranks("/files/{name}.json", "/files/{name}")).toBe(true);
  });

  it("ranks a path by its loosest reading, then by how few it has", () => {
    expect(outranks("/api/orders", "/api(/v2|)/orders")).toBe(true);
    expect(outranks("/api/(v1|v2)/orders", "/api/{v}/orders")).toBe(true);
  });

  it("ranks two paths of one shape equal", () => {
    expect(
      compareRanks(
        pathSpecificity("/orders/{id}"),
        pathSpecificity("/orders/{orderId}"),
      ),
    ).toBe(0);
  });
});
