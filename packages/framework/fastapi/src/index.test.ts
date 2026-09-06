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
        injectedParameterCallees: ["Depends", "Security"],
        defaultStatusCode: 200,
        responseModelKeyword: "response_model",
        statusCodeKeyword: "status_code",
        responseStatusCalls: [
          {
            callee: "fastapi.HTTPException",
            statusKeyword: "status_code",
            statusArgument: 0,
          },
          {
            callee: "starlette.exceptions.HTTPException",
            statusKeyword: "status_code",
            statusArgument: 0,
          },
        ],
        routerComposition: {
          routerConstructorName: "APIRouter",
          includeMethodName: "include_router",
          routerKeyword: "router",
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
