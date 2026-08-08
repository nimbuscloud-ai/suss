import { describe, expect, it } from "vitest";

import { httpRouteDiscovery } from "./packHelpers.js";

describe("httpRouteDiscovery", () => {
  it("emits one DiscoveryPattern per importName with the shared binding-extraction shape", () => {
    const patterns = httpRouteDiscovery({
      importModule: "express",
      importNames: ["Router", "express"],
      methods: [".get", ".post"],
    });

    expect(patterns).toHaveLength(2);
    expect(patterns[0]).toEqual({
      kind: "handler",
      match: {
        type: "registrationCall",
        importModule: "express",
        importName: "Router",
        registrationChain: [".get", ".post"],
      },
      bindingExtraction: {
        method: {
          type: "fromRegistration",
          position: "methodName",
          nameMap: { all: "*" },
        },
        path: { type: "fromRegistration", position: 0 },
      },
      requiresImport: ["express"],
    });
    expect(patterns[1].match).toMatchObject({ importName: "express" });
  });

  it("passes the caller's method list through verbatim", () => {
    const methods = [".get", ".head", ".options"];
    const patterns = httpRouteDiscovery({
      importModule: "fastify",
      importNames: ["fastify"],
      methods,
    });

    if (patterns[0].match.type !== "registrationCall") {
      throw new Error("expected registrationCall match");
    }
    expect(patterns[0].match.registrationChain).toEqual(methods);
    // The caller's array is not kept by reference. Packs are meant to be
    // immutable data at runtime, so mutating the caller's input must not
    // show up in the patterns that were already produced.
    methods.push(".trace");
    expect(patterns[0].match.registrationChain).toEqual([
      ".get",
      ".head",
      ".options",
    ]);
  });

  it("accepts a custom kind (defaults to 'handler')", () => {
    const patterns = httpRouteDiscovery({
      importModule: "custom",
      importNames: ["custom"],
      methods: [".get"],
      kind: "route",
    });
    expect(patterns[0].kind).toBe("route");
  });

  it("returns an empty array when importNames is empty", () => {
    expect(
      httpRouteDiscovery({
        importModule: "whatever",
        importNames: [],
        methods: [".get"],
      }),
    ).toEqual([]);
  });

  it("carries the mount config onto every produced pattern when set", () => {
    const patterns = httpRouteDiscovery({
      importModule: "express",
      importNames: ["Router", "express"],
      methods: [".get"],
      mount: { method: "use", prefixPosition: 0, targetPosition: 1 },
    });
    for (const pattern of patterns) {
      expect(pattern.mount).toEqual({
        method: "use",
        prefixPosition: 0,
        targetPosition: 1,
      });
    }
  });

  it("omits mount when the caller doesn't set it", () => {
    const patterns = httpRouteDiscovery({
      importModule: "express",
      importNames: ["Router"],
      methods: [".get"],
    });
    expect(patterns[0].mount).toBeUndefined();
  });
});
