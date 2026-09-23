import type { PatternPack } from "@suss/extractor";
import type { PackDeclaration } from "@suss/ir-core";

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
          path: { type: "fromArgument", position: 0 },
        },
        // `fetch` is a global, so there is no import to gate on. Walking
        // every file stays cheap because discovery only looks for calls
        // named `fetch`.
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

/** What this pack reads, and what a project has to be using for it to. */
export const declares: PackDeclaration = {
  kind: "client",
  package: "@suss/client-web",
  dependencies: [],
  shippedWith: "typescript",
  reads: "Global \`fetch\` call sites.",
};

export default webFetchPack;
