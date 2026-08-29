import { describe, expect, it } from "vitest";

import { agreedMountPrefix, type MountEdge, mountPathsOf } from "./mount.js";

function edgesOf(
  pairs: Record<string, MountEdge[]>,
): ReadonlyMap<string, readonly MountEdge[]> {
  return new Map(Object.entries(pairs));
}

describe("what mount composition says per edge shape", () => {
  it("an unmounted child composes to the empty prefix", () => {
    expect(mountPathsOf(edgesOf({}), "router")).toEqual([""]);
    expect(agreedMountPrefix(edgesOf({}), "router")).toBe("");
  });

  it("one mount composes one prefix", () => {
    const edges = edgesOf({
      router: [{ parentId: "app", prefix: "/api" }],
    });
    expect(agreedMountPrefix(edges, "router")).toBe("/api");
  });

  it("a chain longer than any old hop bound composes through", () => {
    const pairs: Record<string, MountEdge[]> = {};
    for (let i = 1; i <= 7; i++) {
      pairs[`r${i}`] = [{ parentId: `r${i - 1}`, prefix: `/v${i}` }];
    }
    expect(agreedMountPrefix(edgesOf(pairs), "r7")).toBe(
      "/v1/v2/v3/v4/v5/v6/v7",
    );
  });

  it("a router mounted twice states both paths and agrees on neither", () => {
    const edges = edgesOf({
      router: [
        { parentId: "appA", prefix: "/api" },
        { parentId: "appB", prefix: "/internal" },
      ],
    });
    expect(mountPathsOf(edges, "router")?.slice().sort()).toEqual([
      "/api",
      "/internal",
    ]);
    expect(agreedMountPrefix(edges, "router")).toBeNull();
  });

  it("two mounts landing at the one path agree", () => {
    const edges = edgesOf({
      router: [
        { parentId: "appA", prefix: "/api" },
        { parentId: "appB", prefix: "/api" },
      ],
    });
    expect(agreedMountPrefix(edges, "router")).toBe("/api");
  });

  it("identical local prefixes with different ancestors disagree", () => {
    const edges = edgesOf({
      router: [
        { parentId: "app1", prefix: "/api" },
        { parentId: "app2", prefix: "/api" },
      ],
      app1: [{ parentId: "root", prefix: "/v1" }],
    });
    expect(agreedMountPrefix(edges, "router")).toBeNull();
  });

  it("a cycle says nothing", () => {
    const edges = edgesOf({
      a: [{ parentId: "b", prefix: "/x" }],
      b: [{ parentId: "a", prefix: "/y" }],
    });
    expect(mountPathsOf(edges, "a")).toBeNull();
    expect(agreedMountPrefix(edges, "a")).toBeNull();
  });

  it("a root prefix leaves the child where its parent is", () => {
    const edges = edgesOf({
      router: [{ parentId: "app", prefix: "/api" }],
      leaf: [{ parentId: "router", prefix: "/" }],
    });
    expect(agreedMountPrefix(edges, "leaf")).toBe("/api/");
  });
});
