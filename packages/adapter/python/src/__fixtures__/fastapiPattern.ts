// The route discovery the FastAPI pack supplies, for a test that reads a
// project with `@app.get` and `@app.post` routes. The adapter's own
// source contains none of these strings.

import type { PythonPack } from "../pack.js";

export function fastapiTestPack(): PythonPack {
  return {
    name: "fastapi",
    protocol: "http",
    discovery: [
      {
        type: "decoratedFunctionRoute",
        importModule: ["fastapi"],
        verbAttributeNames: { get: "GET", post: "POST" },
        pathParamSyntax: "braces",
        defaultStatusCode: 200,
      },
    ],
  };
}
