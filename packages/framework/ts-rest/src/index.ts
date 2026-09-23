import type { PatternPack } from "@suss/extractor";
import type { PackDeclaration } from "@suss/ir-core";

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
        // The `@ts-rest` prefix matches every server adapter, such as
        // `@ts-rest/express` and `@ts-rest/fastify`.
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
      // A function that uses a ts-rest client ends by returning or
      // throwing. Without these two it would not match any terminal, and
      // its summary would have no transitions.
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

export const declares: PackDeclaration = {
  kind: "framework",
  package: "@suss/framework-ts-rest",
  dependencies: [{ ecosystem: "npm", name: "@ts-rest/core" }],
  reads:
    "ts-rest handlers and clients, and the contract both sides are built from.",
};

export default tsRestFramework;
