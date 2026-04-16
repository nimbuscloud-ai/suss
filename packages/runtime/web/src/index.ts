import type { FrameworkPack } from "@suss/extractor";

export function webFetchRuntime(): FrameworkPack {
  return {
    name: "fetch",
    languages: ["typescript"],

    discovery: [
      {
        kind: "consumer",
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
  };
}

export default webFetchRuntime;
