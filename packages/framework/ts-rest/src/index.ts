// @suss/framework-ts-rest — PatternPack for ts-rest

import type { PatternPack } from "@suss/extractor";

export function tsRestFramework(): PatternPack {
  return {
    name: "ts-rest",
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
    ],

    contractReading: {
      discovery: {
        importModule: "@ts-rest/core",
        importName: "initContract",
        registrationChain: [".router"],
      },
      responseExtraction: { property: "responses" },
      paramsExtraction: { property: "pathParams" },
    },

    inputMapping: {
      type: "destructuredObject",
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
