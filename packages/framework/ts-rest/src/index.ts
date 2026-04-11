// @suss/framework-ts-rest — FrameworkPack for ts-rest

import type { FrameworkPack } from "@suss/extractor";

export function tsRestFramework(): FrameworkPack {
  return {
    name: "ts-rest",
    languages: ["typescript"],
    discovery: [
      {
        kind: "registrationCall",
        match: {
          kind: "registrationCall",
          importModule: "@ts-rest/express",
          registrationChain: ["initServer", "router"],
        },
        bindingExtraction: {
          methodSource: "contract.method",
          pathSource: "contract.path",
        },
      },
    ],
    terminals: [
      {
        kind: "returnShape",
        match: {
          kind: "returnShape",
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
        kind: "registrationCall",
        match: {
          kind: "registrationCall",
          importModule: "@ts-rest/core",
          registrationChain: ["initContract", "router"],
        },
      },
      responseExtraction: { property: "responses" },
    },
    inputMapping: {
      style: "destructuredObject",
      fields: ["params", "body", "query", "headers"],
    },
  };
}

export default tsRestFramework;
