// @suss/framework-express — FrameworkPack for Express

import type { FrameworkPack } from "@suss/extractor";

export function expressFramework(): FrameworkPack {
  return {
    name: "express",
    languages: ["typescript", "javascript"],

    discovery: [
      {
        // import { Router } from "express"; const router = Router();
        // router.get("/path", handler)
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
      {
        // import express from "express"; const app = express();
        // app.get("/path", handler)
        kind: "handler",
        match: {
          type: "registrationCall",
          importModule: "express",
          importName: "express",
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
        // res.status(N).send(body)
        kind: "response",
        match: {
          type: "parameterMethodCall",
          parameterPosition: 1,
          methodChain: ["status", "send"],
        },
        extraction: {
          statusCode: { from: "argument", position: 0 },
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
        // res.sendStatus(N) — sends status code with status text as body
        kind: "response",
        match: {
          type: "parameterMethodCall",
          parameterPosition: 1,
          methodChain: ["sendStatus"],
        },
        extraction: {
          statusCode: { from: "argument", position: 0 },
        },
      },
      {
        // res.redirect(url) or res.redirect(status, url)
        // The overload makes arg 0 ambiguous (URL vs status code), so we don't
        // extract a status code here. Express defaults to 302.
        kind: "response",
        match: {
          type: "parameterMethodCall",
          parameterPosition: 1,
          methodChain: ["redirect"],
        },
        extraction: {},
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
