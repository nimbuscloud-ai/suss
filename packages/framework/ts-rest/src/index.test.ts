import { describe, it, expect } from "vitest";
import { tsRestFramework } from "./index.js";

describe("tsRestFramework", () => {
  it("returns a valid FrameworkPack", () => {
    const pack = tsRestFramework();
    expect(pack.name).toBe("ts-rest");
    expect(pack.languages).toContain("typescript");
    expect(pack.discovery).toHaveLength(1);
    expect(pack.terminals).toHaveLength(1);
    expect(pack.contractReading).toBeDefined();
  });

  it("discovery kind is 'handler' and match type is 'registrationCall'", () => {
    const pack = tsRestFramework();
    const disc = pack.discovery[0];
    expect(disc.kind).toBe("handler");
    expect(disc.match.type).toBe("registrationCall");
    if (disc.match.type === "registrationCall") {
      expect(disc.match.importModule).toBe("@ts-rest/express");
      expect(disc.match.importName).toBe("initServer");
    }
  });

  it("terminal kind is 'response' and match type is 'returnShape'", () => {
    const pack = tsRestFramework();
    const term = pack.terminals[0];
    expect(term.kind).toBe("response");
    expect(term.match.type).toBe("returnShape");
    if (term.match.type === "returnShape") {
      expect(term.match.requiredProperties).toContain("status");
      expect(term.match.requiredProperties).toContain("body");
    }
  });

  it("inputMapping type is 'destructuredObject' with role-keyed knownProperties", () => {
    const pack = tsRestFramework();
    expect(pack.inputMapping.type).toBe("destructuredObject");
    if (pack.inputMapping.type === "destructuredObject") {
      expect(pack.inputMapping.knownProperties["params"]).toBe("pathParams");
      expect(pack.inputMapping.knownProperties["body"]).toBe("requestBody");
    }
  });

  it("bindingExtraction sources are 'fromContract' for both method and path", () => {
    const pack = tsRestFramework();
    const binding = pack.discovery[0].bindingExtraction;
    expect(binding).toBeDefined();
    expect(binding!.method.type).toBe("fromContract");
    expect(binding!.path.type).toBe("fromContract");
  });
});
