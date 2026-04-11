import { describe, it, expect } from "vitest";
import { reactRouterFramework } from "./index.js";

describe("reactRouterFramework", () => {
  it("returns a valid FrameworkPack structure", () => {
    const pack = reactRouterFramework();
    expect(pack.name).toBe("react-router");
    expect(pack.languages).toContain("typescript");
    expect(pack.discovery.length).toBeGreaterThan(0);
    expect(pack.terminals.length).toBeGreaterThan(0);
  });

  it("discovers loader, action, and default exports", () => {
    const pack = reactRouterFramework();
    const names = pack.discovery.flatMap((d) =>
      d.match.kind === "namedExport" ? d.match.names : []
    );
    expect(names).toContain("loader");
    expect(names).toContain("action");
    expect(names).toContain("default");
  });

  it("uses singleObjectParam input mapping", () => {
    const pack = reactRouterFramework();
    expect(pack.inputMapping.style).toBe("singleObjectParam");
    if (pack.inputMapping.style === "singleObjectParam") {
      expect(pack.inputMapping.fields).toContain("request");
      expect(pack.inputMapping.fields).toContain("params");
    }
  });

  it("includes both returnShape and throwExpression terminals", () => {
    const pack = reactRouterFramework();
    const kinds = pack.terminals.map((t) => t.match.kind);
    expect(kinds).toContain("returnShape");
    expect(kinds).toContain("throwExpression");
  });
});
