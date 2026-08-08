import { describe, expect, it } from "vitest";

import { flaskRestxFramework } from "./index.js";

describe("flaskRestxFramework", () => {
  it("accepts flask_restx's own module by default", () => {
    const pack = flaskRestxFramework();
    expect(pack.name).toBe("flask-restx");
    expect(pack.protocol).toBe("http");
    expect(pack.discovery).toEqual([
      {
        type: "decoratedClassRoute",
        importModule: ["flask_restx"],
        decoratorName: "route",
        verbMethodNames: {
          get: "GET",
          post: "POST",
          put: "PUT",
          delete: "DELETE",
          patch: "PATCH",
          head: "HEAD",
          options: "OPTIONS",
        },
        pathParamSyntax: "flaskConverters",
      },
    ]);
  });

  it("adds a project's wrapper modules alongside flask_restx's own", () => {
    const pack = flaskRestxFramework({
      wrapperModules: ["myapp.wrappers.restx"],
    });
    const [pattern] = pack.discovery;
    expect(pattern?.type).toBe("decoratedClassRoute");
    expect(
      pattern?.type === "decoratedClassRoute" && pattern.importModule,
    ).toEqual(["flask_restx", "myapp.wrappers.restx"]);
  });

  it("is the module's default export too", async () => {
    const mod = await import("./index.js");
    expect(mod.default).toBe(flaskRestxFramework);
  });
});
