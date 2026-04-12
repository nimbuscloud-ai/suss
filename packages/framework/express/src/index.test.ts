import { describe, expect, it } from "vitest";

import { expressFramework } from "./index.js";

describe("expressFramework", () => {
  it("returns a valid FrameworkPack", () => {
    const pack = expressFramework();
    expect(pack.name).toBe("express");
    expect(pack.languages).toContain("typescript");
    expect(pack.discovery).toHaveLength(2);
    expect(pack.terminals.length).toBeGreaterThan(0);
  });

  it("discovers handlers via Router named import", () => {
    const pack = expressFramework();
    const routerDisc = pack.discovery.find(
      (d) =>
        d.match.type === "registrationCall" && d.match.importName === "Router",
    );
    expect(routerDisc).toBeDefined();
    expect(routerDisc!.kind).toBe("handler");
    if (routerDisc!.match.type === "registrationCall") {
      expect(routerDisc!.match.importModule).toBe("express");
    }
  });

  it("discovers handlers via express default import", () => {
    const pack = expressFramework();
    const appDisc = pack.discovery.find(
      (d) =>
        d.match.type === "registrationCall" && d.match.importName === "express",
    );
    expect(appDisc).toBeDefined();
    expect(appDisc!.kind).toBe("handler");
    if (appDisc!.match.type === "registrationCall") {
      expect(appDisc!.match.importModule).toBe("express");
    }
  });

  it("bindingExtraction reads method from registration method name and path from first arg", () => {
    const pack = expressFramework();
    for (const disc of pack.discovery) {
      const binding = disc.bindingExtraction;
      expect(binding?.method).toEqual({
        type: "fromRegistration",
        position: "methodName",
      });
      expect(binding?.path).toEqual({ type: "fromRegistration", position: 0 });
    }
  });

  it("includes parameterMethodCall terminals for common response patterns", () => {
    const pack = expressFramework();
    const methodCallTerminals = pack.terminals.filter(
      (t) => t.match.type === "parameterMethodCall",
    );
    const chains = methodCallTerminals.map((t) =>
      t.match.type === "parameterMethodCall" ? t.match.methodChain : [],
    );
    // res.status(N).json(body)
    expect(chains).toContainEqual(["status", "json"]);
    // res.json(body)
    expect(chains).toContainEqual(["json"]);
    // res.status(N).send(body)
    expect(chains).toContainEqual(["status", "send"]);
    // res.send(body)
    expect(chains).toContainEqual(["send"]);
    // res.sendStatus(N)
    expect(chains).toContainEqual(["sendStatus"]);
    // res.redirect(url)
    expect(chains).toContainEqual(["redirect"]);
  });

  it("inputMapping type is 'positionalParams' with 3 positions", () => {
    const pack = expressFramework();
    expect(pack.inputMapping.type).toBe("positionalParams");
    if (pack.inputMapping.type === "positionalParams") {
      expect(pack.inputMapping.params).toHaveLength(3);
      expect(pack.inputMapping.params[0].role).toBe("request");
      expect(pack.inputMapping.params[1].role).toBe("response");
      expect(pack.inputMapping.params[2].role).toBe("next");
    }
  });
});
