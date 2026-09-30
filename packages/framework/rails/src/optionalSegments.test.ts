import { describe, expect, it } from "vitest";

import { pathWithOptionalGroups } from "./optionalSegments.js";

describe("pathWithOptionalGroups", () => {
  it("leaves a path with no group as it is", () => {
    expect(pathWithOptionalGroups("/orders/:id")).toBe("/orders/:id");
  });

  it("keeps the segments every reading shares outside the set", () => {
    expect(pathWithOptionalGroups("/(/locale/:locale)/articles")).toBe(
      "/(|locale/:locale/)articles",
    );
    expect(pathWithOptionalGroups("/api(/v1)/users")).toBe("/api(|/v1)/users");
    expect(pathWithOptionalGroups("/(:locale)")).toBe("/(|:locale)");
  });

  it("reads a group inside a segment", () => {
    expect(pathWithOptionalGroups("/feed(.:format)")).toBe(
      "/(feed|feed.:format)",
    );
  });

  it("reads a group inside another group", () => {
    expect(pathWithOptionalGroups("/pages(/:section(/:page))")).toBe(
      "/pages(|/:section|/:section/:page)",
    );
  });

  it("reads two groups one after the other", () => {
    expect(pathWithOptionalGroups("/(:locale)/(:region)/shops")).toBe(
      "/(|:region/|:locale/|:locale/:region/)shops",
    );
  });

  it("reads a glob as a hole that takes one segment or more", () => {
    expect(pathWithOptionalGroups("/files/*rest")).toBe("/files/:rest+");
    expect(pathWithOptionalGroups("/media/:id/(*any)")).toBe(
      "/media/:id(|/:any+)",
    );
  });

  it("leaves a path whose parentheses do not balance as it is", () => {
    expect(pathWithOptionalGroups("/a(/b")).toBe("/a(/b");
    expect(pathWithOptionalGroups("/a)/b(")).toBe("/a)/b(");
  });

  it("drops the groups when a set could not be read back", () => {
    expect(pathWithOptionalGroups("/files(/a|b)")).toBe("/files");
  });

  it("drops the groups once they allow too many paths to list", () => {
    const groups = Array.from({ length: 8 }, (_, n) => `(/s${n})`).join("");
    expect(pathWithOptionalGroups(`/root${groups}`)).toBe("/root(|/s7)");
  });
});
