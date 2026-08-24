// @suss/framework-ts-rest: PatternPack for ts-rest

import type { PatternPack } from "@suss/extractor";

export function tsRestFramework(): PatternPack {
  return {
    name: "ts-rest",
    protocol: "http",
    languages: ["typescript"],

    discovery: [
      {
        kind: "handler",
        match: {
          type: "registrationCall",
          importModule: "@ts-rest/express",
          importName: "initServer",
          registrationChain: [".router"],
        },
        bindingExtraction: {
          method: { type: "fromContract" },
          path: { type: "fromContract" },
        },
        // Pre-filter to ts-rest server callers. The `@ts-rest/`
        // prefix sweeps any of the framework's adapters in one
        // go (`@ts-rest/express` / `@ts-rest/fastify` /
        // `@ts-rest/nest` / etc.).
        requiresImport: ["@ts-rest"],
      },
      {
        kind: "client",
        match: {
          type: "clientCall",
          importModule: "@ts-rest/core",
          importName: "initClient",
        },
        bindingExtraction: {
          method: { type: "fromClientMethod" },
          path: { type: "fromClientMethod" },
        },
        requiresImport: ["@ts-rest"],
      },
    ],

    terminals: [
      {
        // ts-rest handlers return { status: N, body: ... }
        kind: "response",
        match: {
          type: "returnShape",
          requiredProperties: ["status", "body"],
        },
        extraction: {
          statusCode: { from: "property", name: "status" },
          body: { from: "property", name: "body" },
        },
      },
      // A consumer of a ts-rest client finishes the way any function
      // does, by returning or throwing. Without these two it matches
      // no terminal at all and its summary says nothing.
      { kind: "return", match: { type: "returnStatement" }, extraction: {} },
      { kind: "throw", match: { type: "throwExpression" }, extraction: {} },
    ],

    contractReading: {
      discovery: {
        importModule: "@ts-rest/core",
        importName: "initContract",
        registrationChain: [".router"],
      },
      responseExtraction: { property: "responses" },
      methodProperty: "method",
      pathProperty: "path",
      paramsExtraction: { property: "pathParams" },
    },

    inputMapping: {
      type: "objectParam",
      knownProperties: {
        params: "pathParams",
        body: "requestBody",
        query: "queryParams",
        headers: "headers",
      },
    },

    responseSemantics: [
      { name: "status", access: "property", semantics: { type: "statusCode" } },
      { name: "body", access: "property", semantics: { type: "body" } },
      { name: "headers", access: "property", semantics: { type: "headers" } },
    ],
  };
}

export default tsRestFramework;
