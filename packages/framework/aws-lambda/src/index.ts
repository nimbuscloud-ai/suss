// @suss/framework-aws-lambda — PatternPack for AWS Lambda HTTP handlers.
//
// The template declares the routing (SAM `Events: { HttpApi | Api }`),
// the code declares the behavior (the handler's return envelope). This
// pack extracts the code side and binds it to the same REST identity the
// declared route carries, so the two pair by `(method, normalizedPath)`.
//
// Discovery is template-driven (see `discovery.ts`): handlers are found
// by resolving each Serverless::Function's `Handler` back to a source
// file + export, not by an in-code registration call. Envelope
// extraction covers the two dominant shapes:
//
//   1. A direct object literal `{ statusCode, body, headers? }`, where
//      `body` is `JSON.stringify(x)` (the shape of `x` is what pairs) or
//      a string.
//   2. A same-module helper — `json(payload, status?)` /
//      `redirect(url, status?)` — that wraps the envelope. The helper's
//      argument is the payload shape; the pack declares the envelope its
//      name implies rather than resolving the helper body.
//
// Out of scope: SQS / Schedule / SNS event handlers. Those surface as
// `recognized-not-http` accounting units (see `discovery.ts`) — the
// message-bus pass in @suss/contract-cloudformation owns SQS consumers.

import { awsLambdaDiscovery } from "./discovery.js";

import type { PatternPack } from "@suss/extractor";

export { awsLambdaDiscovery, METADATA_NAMESPACE } from "./discovery.js";
export { clearTemplateCache } from "./templateIndex.js";

export function awsLambdaFramework(): PatternPack {
  return {
    name: "aws-lambda",
    protocol: "http",
    languages: ["typescript", "javascript"],

    // No data-driven discovery: routing lives in the SAM/CFN template,
    // not in code. The callback resolves handlers against the template.
    discovery: [],
    discoverUnits: awsLambdaDiscovery,

    // Gate on the `aws-lambda` types import — the discovery callback's
    // per-file template lookup is cheap but pointless on files that
    // aren't typed handlers. Handlers the template declares but that
    // don't import the types are out of v0 scope; they still surface as
    // declared routes on the contract side.
    requiresImport: ["aws-lambda"],

    terminals: [
      {
        // Direct proxy envelope: `return { statusCode, body, headers? }`.
        // `body` is the serialized payload — unwrap `JSON.stringify(x)`
        // to the shape of `x` so it pairs with the declared body.
        kind: "response",
        match: { type: "returnShape", requiredProperties: ["statusCode"] },
        extraction: {
          statusCode: { from: "property", name: "statusCode" },
          body: { from: "property", name: "body", unwrapJsonStringify: true },
        },
      },
      {
        // `return json(payload, status?)` — same-module response helper.
        // Payload is arg 0; an explicit status is arg 1, else 200.
        kind: "response",
        match: { type: "functionCall", functionName: "json" },
        extraction: {
          statusCode: { from: "argument", position: 1 },
          body: { from: "argument", position: 0 },
          defaultStatusCode: 200,
        },
      },
      {
        // `return redirect(url, status?)` — location redirect helper.
        kind: "response",
        match: { type: "functionCall", functionName: "redirect" },
        extraction: {
          statusCode: { from: "argument", position: 1 },
          defaultStatusCode: 302,
        },
      },
      {
        // `throw new SomeError(...)` — an uncaught throw becomes a
        // throw-output transition; API Gateway maps it to a 5xx, but the
        // specific status is the platform's, not the handler's.
        kind: "throw",
        match: { type: "throwExpression" },
        extraction: {},
      },
    ],

    // Lambda's handler signature is `(event, context, callback?)`. The
    // HTTP request data (path params, query, body) lives on `event`;
    // decomposing it into typed inputs is a follow-up.
    inputMapping: {
      type: "positionalParams",
      params: [
        { position: 0, role: "event" },
        { position: 1, role: "context" },
      ],
    },
  };
}

export default awsLambdaFramework;
