import { describe, expect, it } from "vitest";

import { expressFramework } from "./index.js";

describe("expressFramework", () => {
  it("returns a valid FrameworkPack", () => {
    const pack = expressFramework();
    expect(pack.name).toBe("express");
    expect(pack.languages).toContain("typescript");
    expect(pack.discovery).toHaveLength(1);
    expect(pack.terminals.length).toBeGreaterThan(0);
  });

  it("discovery kind is 'handler' and match type is 'registrationCall'", () => {
    const pack = expressFramework();
    const disc = pack.discovery[0];
    expect(disc.kind).toBe("handler");
    expect(disc.match.type).toBe("registrationCall");
    if (disc.match.type === "registrationCall") {
      expect(disc.match.importModule).toBe("express");
    }
  });

  it("bindingExtraction reads method from registration method name and path from first arg", () => {
    const pack = expressFramework();
    const binding = pack.discovery[0].bindingExtraction;
    expect(binding?.method).toEqual({
      type: "fromRegistration",
      position: "methodName",
    });
    expect(binding?.path).toEqual({ type: "fromRegistration", position: 0 });
  });

  it("includes parameterMethodCall terminals for res.json and res.send", () => {
    const pack = expressFramework();
    const methodCallTerminals = pack.terminals.filter(
      (t) => t.match.type === "parameterMethodCall",
    );
    expect(methodCallTerminals.length).toBeGreaterThan(0);
    const methods = methodCallTerminals.map((t) =>
      t.match.type === "parameterMethodCall" ? t.match.methodChain : [],
    );
    expect(methods.some((m) => m.includes("json"))).toBe(true);
    expect(methods.some((m) => m.includes("send"))).toBe(true);
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
