// @suss/framework-react-router — FrameworkPack for React Router

import type { FrameworkPack } from "@suss/extractor";

export function reactRouterFramework(): FrameworkPack {
  return {
    name: "react-router",
    languages: ["typescript", "javascript"],

    discovery: [
      {
        kind: "loader",
        match: { type: "namedExport", names: ["loader"] },
        bindingExtraction: {
          method: { type: "literal", value: "GET" },
          path: { type: "fromFilename" },
        },
      },
      {
        kind: "action",
        match: { type: "namedExport", names: ["action"] },
        bindingExtraction: {
          method: { type: "literal", value: "POST" },
          path: { type: "fromFilename" },
        },
      },
      {
        kind: "component",
        match: { type: "namedExport", names: ["default"] },
      },
    ],

    terminals: [
      {
        // Loaders return data directly
        kind: "return",
        match: { type: "returnShape" },
        extraction: {
          body: { from: "argument", position: 0 },
        },
      },
      {
        // Loaders can throw httpErrorJson(statusCode, body)
        kind: "throw",
        match: {
          type: "throwExpression",
          constructorPattern: "httpErrorJson",
        },
        extraction: {
          statusCode: { from: "argument", position: 0 },
          body: { from: "argument", position: 1 },
        },
      },
    ],

    inputMapping: {
      type: "singleObjectParam",
      paramPosition: 0,
      knownProperties: {
        request: "request",
        params: "pathParams",
        context: "context",
      },
    },
  };
}

export default reactRouterFramework;
