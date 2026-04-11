// @suss/framework-react-router — FrameworkPack for React Router

import type { FrameworkPack } from "@suss/extractor";

export function reactRouterFramework(): FrameworkPack {
  return {
    name: "react-router",
    languages: ["typescript"],
    discovery: [
      {
        kind: "namedExport",
        match: { kind: "namedExport", names: ["loader"] },
      },
      {
        kind: "namedExport",
        match: { kind: "namedExport", names: ["action"] },
      },
      {
        kind: "namedExport",
        match: { kind: "namedExport", names: ["default"] },
      },
    ],
    terminals: [
      {
        kind: "returnShape",
        match: { kind: "returnShape" },
        extraction: {
          statusCode: { from: "property", name: "status" },
          body: { from: "property", name: "body" },
        },
      },
      {
        kind: "throwExpression",
        match: { kind: "throwExpression", constructorPattern: "httpErrorJson" },
        extraction: {
          statusCode: { from: "argument", position: 0 },
          body: { from: "argument", position: 1 },
        },
      },
    ],
    inputMapping: {
      style: "singleObjectParam",
      position: 0,
      fields: ["request", "params", "context"],
    },
  };
}

export default reactRouterFramework;
