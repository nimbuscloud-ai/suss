import { describe, expect, it } from "vitest";

import { fastapiFramework } from "./index.js";

describe("fastapiFramework", () => {
  it("accepts fastapi's own module by default", () => {
    const pack = fastapiFramework();
    expect(pack.name).toBe("fastapi");
    expect(pack.protocol).toBe("http");
    expect(pack.discovery).toEqual([
      {
        type: "decoratedFunctionRoute",
        importModule: ["fastapi"],
        verbAttributeNames: {
          get: "GET",
          post: "POST",
          put: "PUT",
          patch: "PATCH",
          delete: "DELETE",
          head: "HEAD",
          options: "OPTIONS",
        },
        pathParamSyntax: "braces",
        annotatedClassIsRequestBody: true,
        responseModelKeyword: "response_model",
        statusCodeKeyword: "status_code",
        routerComposition: {
          routerConstructorName: "APIRouter",
          includeMethodName: "include_router",
          prefixKeyword: "prefix",
        },
      },
    ]);
  });

  it("adds a project's wrapper modules alongside fastapi's own", () => {
    const pack = fastapiFramework({ wrapperModules: ["myapp.compat"] });
    const [pattern] = pack.discovery;
    expect(pattern?.type).toBe("decoratedFunctionRoute");
    expect(
      pattern?.type === "decoratedFunctionRoute" && pattern.importModule,
    ).toEqual(["fastapi", "myapp.compat"]);
  });

  it("is the module's default export too", async () => {
    const mod = await import("./index.js");
    expect(mod.default).toBe(fastapiFramework);
  });
});
