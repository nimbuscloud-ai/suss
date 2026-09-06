import { describe, expect, it } from "vitest";

import {
  httpRouteDiscovery,
  registrationHelperDiscovery,
  routeHelperIndex,
  wrapperDiscovery,
} from "./packHelpers.js";

import type { DiscoveryPattern } from "./framework.js";
import type { ProjectHelper } from "./projectHelpers.js";

describe("httpRouteDiscovery", () => {
  it("emits one DiscoveryPattern per importName with the shared binding-extraction shape", () => {
    const patterns = httpRouteDiscovery({
      importModule: "express",
      importNames: ["Router", "express"],
      methods: [".get", ".post"],
    });

    // One registration-call pattern per import, and the loop pattern
    // every HTTP pack gets.
    expect(patterns).toHaveLength(3);
    expect(patterns[2]?.match).toMatchObject({
      type: "registrationLoop",
      receiver: { importModule: "express", importNames: ["Router", "express"] },
    });
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
        path: { type: "fromArgument", position: 0 },
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
    const calls = patterns.filter(
      (one) => one.match.type === "registrationCall",
    );
    // The loop pattern registers routes rather than mounting anything,
    // so the mount config goes on the call patterns alone.
    expect(calls.length).toBeGreaterThan(0);
    for (const pattern of calls) {
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

describe("wrapperDiscovery", () => {
  it("gives one pattern per import name and wrapper shape", () => {
    const patterns = wrapperDiscovery({
      importModule: "express",
      importNames: ["Router", "express"],
      wraps: [
        { method: "use", targetPosition: 0 },
        { method: "use", targetPosition: 0, throwParam: 0, arity: 4 },
      ],
    });

    expect(patterns).toHaveLength(4);
    expect(patterns.map((one) => one.kind)).toEqual([
      "middleware",
      "middleware",
      "middleware",
      "middleware",
    ]);
    expect(patterns[0].wraps).toEqual({ method: "use", targetPosition: 0 });
    expect(patterns[1].wraps).toEqual({
      method: "use",
      targetPosition: 0,
      throwParam: 0,
      arity: 4,
    });
    expect(patterns[0].requiresImport).toEqual(["express"]);
  });

  it("registers no routes of its own, so its chain is empty", () => {
    const patterns = wrapperDiscovery({
      importModule: "hono",
      importNames: ["Hono"],
      wraps: [{ method: "onError", targetPosition: 0, throwParam: 0 }],
      kind: "handler",
    });

    expect(patterns[0].kind).toBe("handler");
    expect(patterns[0].bindingExtraction).toBeUndefined();
    expect(
      patterns[0].match.type === "registrationCall"
        ? patterns[0].match.registrationChain
        : null,
    ).toEqual([]);
  });
});

describe("registrationHelperDiscovery", () => {
  it("turns each helper into one registrationTemplate pattern", () => {
    const patterns = registrationHelperDiscovery([
      {
        helperName: "registerCrud",
        importModule: "./crud.js",
        registrations: [
          { method: "GET", pathTemplate: "/{1}", handlerArg: "{2}.list" },
          { method: "POST", pathTemplate: "/{1}", handlerArg: "{2}.create" },
        ],
      },
    ]);

    expect(patterns).toEqual([
      {
        kind: "handler",
        match: {
          type: "registrationTemplate",
          helperName: "registerCrud",
          importModule: "./crud.js",
          registrations: [
            { method: "GET", pathTemplate: "/{1}", handlerArg: "{2}.list" },
            { method: "POST", pathTemplate: "/{1}", handlerArg: "{2}.create" },
          ],
        },
      },
    ]);
  });

  it("leaves importModule off when the helper does not say one", () => {
    const [pattern] = registrationHelperDiscovery([
      { helperName: "mount", registrations: [] },
    ]);

    expect(pattern?.match).not.toHaveProperty("importModule");
  });

  it("produces nothing from no helpers, so the default costs nothing", () => {
    expect(registrationHelperDiscovery([])).toEqual([]);
  });

  it("keeps the file the index read the helper out of", () => {
    const [pattern] = registrationHelperDiscovery([
      {
        helperName: "registerCrud",
        importModule: "/repo/src/routes/crud.ts",
        registrations: [],
      },
    ]);

    expect(readImportModule(pattern)).toBe("/repo/src/routes/crud.ts");
  });
});

describe("routeHelperIndex", () => {
  const index = routeHelperIndex({
    importModule: "express",
    importNames: ["Router", "express"],
    methods: [".get", ".post", ".all"],
  });

  /** One `app.get(`/${name}`, handlers.list)` inside a helper. */
  const registerCrud = (over: Partial<ProjectHelper> = {}): ProjectHelper => ({
    name: "registerCrud",
    file: "/repo/src/crud.ts",
    parameters: ["app", "name", "handlers"],
    subjectParameters: [0],
    sinks: [
      {
        method: "get",
        receiver: { as: "parameter", position: 0 },
        arguments: [
          { as: "text", text: "/{1}" },
          { as: "parameter", position: 2, property: "list" },
        ],
      },
    ],
    ...over,
  });

  it("asks for helpers found from a call site", () => {
    expect(index.find).toEqual({ by: "subject" });
  });

  it("turns what a helper registers into one template per helper", () => {
    const [pattern] = index.declare([registerCrud()]).discovery ?? [];

    expect(pattern?.match).toEqual({
      type: "registrationTemplate",
      helperName: "registerCrud",
      importModule: "/repo/src/crud.ts",
      subject: {
        argument: 0,
        importModule: "express",
        importNames: ["Router", "express"],
      },
      registrations: [
        { method: "GET", pathTemplate: "/{1}", handlerArg: "{2}.list" },
      ],
    });
  });

  it("reads `.all` as the wildcard the pairing engine spells", () => {
    const [pattern] =
      index.declare([
        registerCrud({
          sinks: [
            {
              method: "all",
              receiver: { as: "parameter", position: 0 },
              arguments: [
                { as: "text", text: "/{1}" },
                { as: "parameter", position: 2, property: "list" },
              ],
            },
          ],
        }),
      ]).discovery ?? [];

    expect(
      pattern?.match.type === "registrationTemplate"
        ? pattern.match.registrations[0]?.method
        : null,
    ).toBe("*");
  });

  it("drops a registration whose handler the call site does not supply", () => {
    const declared = index.declare([
      registerCrud({
        sinks: [
          {
            method: "get",
            receiver: { as: "parameter", position: 0 },
            arguments: [{ as: "text", text: "/health" }, { as: "unread" }],
          },
        ],
      }),
    ]);

    expect(declared.discovery).toEqual([]);
  });

  it("drops a registration whose path the reading could not fill in", () => {
    const declared = index.declare([
      registerCrud({
        sinks: [
          {
            method: "get",
            receiver: { as: "parameter", position: 0 },
            arguments: [
              { as: "unread" },
              { as: "parameter", position: 2, property: "list" },
            ],
          },
        ],
      }),
    ]);

    expect(declared.discovery).toEqual([]);
  });

  it("leaves a call on a parameter no caller passed the app to alone", () => {
    const declared = index.declare([registerCrud({ subjectParameters: [1] })]);

    expect(declared.discovery).toEqual([]);
  });

  it("leaves a method this framework does not register with alone", () => {
    const declared = index.declare([
      registerCrud({
        sinks: [
          {
            method: "subscribe",
            receiver: { as: "parameter", position: 0 },
            arguments: [
              { as: "text", text: "/{1}" },
              { as: "parameter", position: 2, property: "list" },
            ],
          },
        ],
      }),
    ]);

    expect(declared.discovery).toEqual([]);
  });
});

function readImportModule(pattern: DiscoveryPattern | undefined) {
  return pattern?.match.type === "registrationTemplate"
    ? pattern.match.importModule
    : null;
}
