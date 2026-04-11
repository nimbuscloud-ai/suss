import { describe, it, expect } from "vitest";
import { tsRestFramework } from "./index.js";

describe("tsRestFramework", () => {
  it("returns a valid FrameworkPack structure", () => {
    const pack = tsRestFramework();
    expect(pack.name).toBe("ts-rest");
    expect(pack.languages).toContain("typescript");
    expect(pack.discovery).toHaveLength(1);
    expect(pack.terminals).toHaveLength(1);
    expect(pack.contractReading).toBeDefined();
    expect(pack.inputMapping.style).toBe("destructuredObject");
  });

  it("discovery uses registrationCall match kind", () => {
    const pack = tsRestFramework();
    const disc = pack.discovery[0];
    expect(disc.match.kind).toBe("registrationCall");
    if (disc.match.kind === "registrationCall") {
      expect(disc.match.importModule).toBe("@ts-rest/express");
      expect(disc.match.registrationChain).toContain("initServer");
    }
  });

  it("terminal uses returnShape with required status and body", () => {
    const pack = tsRestFramework();
    const term = pack.terminals[0];
    expect(term.match.kind).toBe("returnShape");
    if (term.match.kind === "returnShape") {
      expect(term.match.requiredProperties).toContain("status");
      expect(term.match.requiredProperties).toContain("body");
    }
  });

  it("inputMapping uses destructuredObject style", () => {
    const pack = tsRestFramework();
    expect(pack.inputMapping.style).toBe("destructuredObject");
    if (pack.inputMapping.style === "destructuredObject") {
      expect(pack.inputMapping.fields).toContain("params");
      expect(pack.inputMapping.fields).toContain("body");
    }
  });
});
