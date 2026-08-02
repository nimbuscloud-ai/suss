import { describe, expect, it } from "vitest";

import { namesAnyPackage, namesPackage } from "./moduleGraph.js";

describe("namesPackage", () => {
  it("matches the package itself", () => {
    expect(namesPackage(["@aws-sdk/client-sqs"], "@aws-sdk/client-sqs")).toBe(
      true,
    );
  });

  it("matches a subpath of the package", () => {
    expect(
      namesPackage(["@aws-sdk/client-sqs/internals"], "@aws-sdk/client-sqs"),
    ).toBe(true);
  });

  it("does not match a package that merely starts the same way", () => {
    expect(
      namesPackage(["@aws-sdk/client-sqs-extra"], "@aws-sdk/client-sqs"),
    ).toBe(false);
  });

  it("says no for a file that names nothing relevant", () => {
    expect(namesPackage(["./local", "node:fs"], "express")).toBe(false);
  });
});

describe("namesAnyPackage", () => {
  it("matches when one of the names is there", () => {
    expect(namesAnyPackage(["react", "./local"], ["express", "react"])).toBe(
      true,
    );
  });

  it("says no when none of them is", () => {
    expect(namesAnyPackage(["react"], ["express", "fastify"])).toBe(false);
  });

  it("says no when there are no names to match", () => {
    expect(namesAnyPackage(["react"], [])).toBe(false);
  });
});
