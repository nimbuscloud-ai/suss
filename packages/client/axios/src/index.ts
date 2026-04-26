// @suss/client-axios — PatternPack for the axios HTTP client

import type { DiscoveryPattern, PatternPack } from "@suss/extractor";

const HTTP_METHODS = [
  "get",
  "post",
  "put",
  "delete",
  "patch",
  "head",
  "options",
] as const;

function discoveryForVerb(
  verb: (typeof HTTP_METHODS)[number],
): DiscoveryPattern {
  return {
    // Matches both shapes:
    //   axios.<verb>("/path", ...)
    //   const api = axios.create({ ... }); api.<verb>("/path", ...)
    // The factoryMethods entry tells the adapter that variables initialized
    // from `axios.create(...)` are also clients.
    kind: "client",
    match: {
      type: "clientCall",
      importModule: "axios",
      importName: "axios",
      methodFilter: [verb],
      factoryMethods: ["create"],
    },
    bindingExtraction: {
      method: { type: "literal", value: verb.toUpperCase() },
      path: { type: "fromArgumentLiteral", position: 0 },
    },
    requiresImport: ["axios"],
  };
}

export function axiosPack(): PatternPack {
  return {
    name: "axios",
    protocol: "http",
    languages: ["typescript", "javascript"],

    discovery: HTTP_METHODS.map(discoveryForVerb),

    terminals: [
      {
        kind: "return",
        match: { type: "returnStatement" },
        extraction: {},
      },
      {
        kind: "throw",
        match: { type: "throwExpression" },
        extraction: {},
      },
    ],

    inputMapping: {
      type: "positionalParams",
      params: [],
    },

    responseSemantics: [
      // axios returns AxiosResponse — body lives on .data, not .body or .json()
      { name: "data", access: "property", semantics: { type: "body" } },
      { name: "status", access: "property", semantics: { type: "statusCode" } },
      { name: "headers", access: "property", semantics: { type: "headers" } },
    ],
  };
}

export default axiosPack;
