import { describe, expect, it } from "vitest";

import {
  createDependencySink,
  recordFileDependency,
  recordMountPrefix,
  recordUnitClaim,
  withDependencySink,
} from "./depTracking.js";

describe("withDependencySink", () => {
  it("collects what runs inside it and nothing after", () => {
    const sink = createDependencySink();
    withDependencySink(sink, () => {
      recordFileDependency("/p/a.ts");
      recordMountPrefix("/p/a.ts:1-2", "/api");
      recordUnitClaim("/p/a.ts:1-2-handler", "test-pack");
    });
    recordFileDependency("/p/after.ts");

    expect([...sink.files]).toEqual(["/p/a.ts"]);
    expect(sink.mountPrefixes.get("/p/a.ts:1-2")).toBe("/api");
    expect(sink.claims).toEqual([
      { key: "/p/a.ts:1-2-handler", pack: "test-pack" },
    ]);
  });

  it("restores the outer sink when a nested one finishes", () => {
    const outer = createDependencySink();
    const inner = createDependencySink();
    withDependencySink(outer, () => {
      withDependencySink(inner, () => {
        recordFileDependency("/p/inner.ts");
      });
      recordFileDependency("/p/outer.ts");
    });

    expect([...inner.files]).toEqual(["/p/inner.ts"]);
    expect([...outer.files]).toEqual(["/p/outer.ts"]);
  });

  it("restores the outer sink when the inner function throws", () => {
    const outer = createDependencySink();
    withDependencySink(outer, () => {
      expect(() =>
        withDependencySink(createDependencySink(), () => {
          throw new Error("boom");
        }),
      ).toThrow("boom");
      recordFileDependency("/p/outer.ts");
    });

    expect([...outer.files]).toEqual(["/p/outer.ts"]);
  });

  it("ignores recordings with nobody collecting", () => {
    expect(() => recordFileDependency("/p/x.ts")).not.toThrow();
  });
});
