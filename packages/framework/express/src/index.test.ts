import { describe, it, expect } from "vitest";
import { expressFramework } from "./index.js";

describe("expressFramework", () => {
  it("returns a valid FrameworkPack structure", () => {
    const pack = expressFramework();
    expect(pack.name).toBe("express");
    expect(pack.languages).toContain("typescript");
    expect(pack.discovery.length).toBeGreaterThan(0);
    expect(pack.terminals.length).toBeGreaterThan(0);
  });

  it("uses registrationCall discovery", () => {
    const pack = expressFramework();
    const disc = pack.discovery[0];
    expect(disc.match.kind).toBe("registrationCall");
    if (disc.match.kind === "registrationCall") {
      expect(disc.match.importModule).toBe("express");
    }
  });

  it("includes parameterMethodCall terminals for res.json and res.send", () => {
    const pack = expressFramework();
    const methodCallTerminals = pack.terminals.filter(
      (t) => t.match.kind === "parameterMethodCall"
    );
    expect(methodCallTerminals.length).toBeGreaterThan(0);
    const methods = methodCallTerminals.map((t) =>
      t.match.kind === "parameterMethodCall" ? t.match.methodChain : []
    );
    expect(methods.some((m) => m.includes("json"))).toBe(true);
    expect(methods.some((m) => m.includes("send"))).toBe(true);
  });

  it("uses positionalParams input mapping with 3 positions", () => {
    const pack = expressFramework();
    expect(pack.inputMapping.style).toBe("positionalParams");
    if (pack.inputMapping.style === "positionalParams") {
      expect(pack.inputMapping.params).toHaveLength(3);
      expect(pack.inputMapping.params[0].role).toBe("request");
      expect(pack.inputMapping.params[1].role).toBe("response");
      expect(pack.inputMapping.params[2].role).toBe("next");
    }
  });
});
