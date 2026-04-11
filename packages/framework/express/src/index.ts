// @suss/framework-express — FrameworkPack for Express

import type { FrameworkPack } from "@suss/extractor";

export function expressFramework(): FrameworkPack {
  return {
    name: "express",
    languages: ["typescript"],
    discovery: [
      {
        kind: "registrationCall",
        match: {
          kind: "registrationCall",
          importModule: "express",
          registrationChain: ["app.get", "app.post", "app.put", "app.delete", "app.patch",
            "router.get", "router.post", "router.put", "router.delete", "router.patch"],
        },
        bindingExtraction: {
          methodSource: "registrationMethod",
          pathSource: "firstArgument",
        },
      },
    ],
    terminals: [
      {
        kind: "parameterMethodCall",
        match: {
          kind: "parameterMethodCall",
          paramPosition: 1,
          methodChain: ["status", "json"],
        },
        extraction: {
          statusCode: { from: "argument", position: 0 },
          body: { from: "argument", position: 0 },
        },
      },
      {
        kind: "parameterMethodCall",
        match: {
          kind: "parameterMethodCall",
          paramPosition: 1,
          methodChain: ["json"],
        },
        extraction: {
          statusCode: { from: "argument", position: 0 },
          body: { from: "argument", position: 0 },
        },
      },
      {
        kind: "parameterMethodCall",
        match: {
          kind: "parameterMethodCall",
          paramPosition: 1,
          methodChain: ["send"],
        },
        extraction: {
          statusCode: { from: "argument", position: 0 },
          body: { from: "argument", position: 0 },
        },
      },
      {
        kind: "throwExpression",
        match: { kind: "throwExpression" },
        extraction: {
          statusCode: { from: "property", name: "status" },
          body: { from: "property", name: "message" },
        },
      },
    ],
    inputMapping: {
      style: "positionalParams",
      params: [
        { position: 0, role: "request" },
        { position: 1, role: "response" },
        { position: 2, role: "next" },
      ],
    },
  };
}

export default expressFramework;
