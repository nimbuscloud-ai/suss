import { describe, expect, it } from "vitest";

import { reactRouterFramework } from "./index.js";

describe("reactRouterFramework", () => {
  it("returns a valid FrameworkPack", () => {
    const pack = reactRouterFramework();
    expect(pack.name).toBe("react-router");
    expect(pack.languages).toContain("typescript");
    expect(pack.discovery).toHaveLength(3);
    expect(pack.terminals).toHaveLength(5);
    expect(pack.contractReading).toBeUndefined();
  });

  it("discovers loader, action, and component via namedExport match type", () => {
    const pack = reactRouterFramework();
    const kinds = pack.discovery.map((d) => d.kind);
    expect(kinds).toContain("loader");
    expect(kinds).toContain("action");
    expect(kinds).toContain("component");
    for (const disc of pack.discovery) {
      expect(disc.match.type).toBe("namedExport");
    }
  });

  it("loader binding extracts method as literal GET and path from filename", () => {
    const pack = reactRouterFramework();
    const loader = pack.discovery.find((d) => d.kind === "loader");
    expect(loader?.bindingExtraction?.method).toEqual({
      type: "literal",
      value: "GET",
    });
    expect(loader?.bindingExtraction?.path).toEqual({ type: "fromFilename" });
  });

  it("terminals cover json/data/redirect helpers, returnShape, and throw", () => {
    const pack = reactRouterFramework();
    const termKinds = pack.terminals.map((t) => t.kind);
    expect(termKinds).toContain("response");
    expect(termKinds).toContain("return");
    expect(termKinds).toContain("throw");

    // functionCall terminals for json(), data(), redirect()
    const fnCallTerminals = pack.terminals.filter(
      (t) => t.match.type === "functionCall",
    );
    expect(fnCallTerminals).toHaveLength(3);
    const fnNames = fnCallTerminals.map((t) =>
      t.match.type === "functionCall" ? t.match.functionName : "",
    );
    expect(fnNames).toContain("json");
    expect(fnNames).toContain("data");
    expect(fnNames).toContain("redirect");

    // throwExpression terminal for httpErrorJson
    const throwTerm = pack.terminals.find((t) => t.kind === "throw");
    expect(throwTerm?.match.type).toBe("throwExpression");
    if (throwTerm?.match.type === "throwExpression") {
      expect(throwTerm.match.constructorPattern).toBe("httpErrorJson");
    }
  });

  it("inputMapping type is 'singleObjectParam' with knownProperties", () => {
    const pack = reactRouterFramework();
    expect(pack.inputMapping.type).toBe("singleObjectParam");
    if (pack.inputMapping.type === "singleObjectParam") {
      expect(pack.inputMapping.paramPosition).toBe(0);
      expect(pack.inputMapping.knownProperties.params).toBe("pathParams");
      expect(pack.inputMapping.knownProperties.request).toBe("request");
    }
  });
});
