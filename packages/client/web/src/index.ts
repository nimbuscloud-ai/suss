import type { PatternPack } from "@suss/extractor";

export function webFetchPack(): PatternPack {
  return {
    name: "fetch",
    protocol: "http",
    languages: ["typescript"],

    discovery: [
      {
        kind: "client",
        match: {
          type: "clientCall",
          importModule: "global",
          importName: "fetch",
        },
        bindingExtraction: {
          method: {
            type: "fromArgumentProperty",
            position: 1,
            property: "method",
            default: "GET",
          },
          path: { type: "fromArgumentLiteral", position: 0 },
        },
        // No import gate: `fetch` is a global. Walk every file —
        // the discovery dispatch is itself cheap (just looks for
        // call expressions named `fetch`), so the lack of pre-
        // filter doesn't blow up perf.
        requiresImport: [],
      },
    ],

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
      {
        name: "ok",
        access: "property",
        semantics: { type: "statusRange", min: 200, max: 299 },
      },
      { name: "status", access: "property", semantics: { type: "statusCode" } },
      { name: "json", access: "method", semantics: { type: "body" } },
      { name: "text", access: "method", semantics: { type: "body" } },
      { name: "body", access: "property", semantics: { type: "body" } },
      { name: "headers", access: "property", semantics: { type: "headers" } },
    ],
  };
}

export default webFetchPack;
