// @suss/framework-express — FrameworkPack for Express

import type { FrameworkPack } from "@suss/extractor";

export function expressFramework(): FrameworkPack {
  return {
    name: "express",
    languages: ["typescript", "javascript"],

    discovery: [
      {
        kind: "handler",
        match: {
          type: "registrationCall",
          importModule: "express",
          importName: "Router",
          registrationChain: [".get", ".post", ".put", ".delete", ".patch"],
        },
        bindingExtraction: {
          method: { type: "fromRegistration", position: "methodName" },
          path: { type: "fromRegistration", position: 0 },
        },
      },
    ],

    terminals: [
      {
        // res.status(N).json(body)
        kind: "response",
        match: {
          type: "parameterMethodCall",
          parameterPosition: 1,
          methodChain: ["status", "json"],
        },
        extraction: {
          statusCode: { from: "argument", position: 0 },
          body: { from: "argument", position: 0 },
        },
      },
      {
        // res.json(body) — implicit 200
        kind: "response",
        match: {
          type: "parameterMethodCall",
          parameterPosition: 1,
          methodChain: ["json"],
        },
        extraction: {
          body: { from: "argument", position: 0 },
        },
      },
      {
        // res.send(body)
        kind: "response",
        match: {
          type: "parameterMethodCall",
          parameterPosition: 1,
          methodChain: ["send"],
        },
        extraction: {
          body: { from: "argument", position: 0 },
        },
      },
      {
        // throw new SomeError(...)
        kind: "throw",
        match: { type: "throwExpression" },
        extraction: {
          statusCode: { from: "property", name: "status" },
        },
      },
    ],

    inputMapping: {
      type: "positionalParams",
      params: [
        { position: 0, role: "request" },
        { position: 1, role: "response" },
        { position: 2, role: "next" },
      ],
    },
  };
}

export default expressFramework;
