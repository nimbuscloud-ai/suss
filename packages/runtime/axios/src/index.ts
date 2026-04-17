// @suss/runtime-axios — PatternPack for the axios HTTP client

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
    // import axios from "axios"; axios.<verb>("/path", ...)
    kind: "client",
    match: {
      type: "clientCall",
      importModule: "axios",
      importName: "axios",
      methodFilter: [verb],
    },
    bindingExtraction: {
      method: { type: "literal", value: verb.toUpperCase() },
      path: { type: "fromArgumentLiteral", position: 0 },
    },
  };
}

export function axiosRuntime(): PatternPack {
  return {
    name: "axios",
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

export default axiosRuntime;
