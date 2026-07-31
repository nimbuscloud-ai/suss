// @suss/framework-aws-lambda — PatternPack for AWS Lambda HTTP handlers.
//
// The template declares the routing (SAM `Events: { HttpApi | Api }`),
// the code declares the behavior (what the handler returns). This
// pack extracts the code side and binds it to the same REST identity the
// declared route carries, so the two pair by `(method, normalizedPath)`.
//
// Discovery is template-driven (see `discovery.ts`): handlers are found
// by resolving each Serverless::Function's `Handler` back to a source
// file + export, not by an in-code registration call.
//
// The pack declares one response shape: an object carrying
// `statusCode`, where `body` is `JSON.stringify(x)`, since the shape of
// `x` is what pairs with a declared body.
//
// Most handlers build that object in a helper rather than at the return
// site, and the helper belongs to the service, so this pack does not try
// to name it. The adapter follows a returned call into the project and
// applies the same declaration to the object it finds there, reading the
// helper's parameters to see which argument carries which field. A
// service writing `json(status, payload)` and one writing
// `json(payload, status)` both come out right, as does one that calls
// the helper `respond`.
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
    // Sentry's wrapper is a library call whose body the adapter cannot
    // read, so the pack states the judgment: the handler is argument 0.
    // Project-local wrappers need no declaration; the adapter derives
    // those by reading the factory body.
    transparentWrappers: [
      {
        callee: "Sentry.wrapHandler",
        argument: 0,
        module: "@sentry/aws-serverless",
      },
    ],
    languages: ["typescript", "javascript"],

    // No data-driven discovery: routing lives in the SAM/CFN template,
    // not in code. The callback resolves handlers against the template.
    discovery: [],
    discoverUnits: awsLambdaDiscovery,

    // No import gate, on purpose.
    //
    // A TypeScript handler writes `import type { APIGatewayProxyHandlerV2 }
    // from "aws-lambda"`, which TypeScript resolves to
    // `@types/aws-lambda`, to annotate its export. A JavaScript handler
    // has nothing to annotate and writes no such import. Gating
    // discovery on it therefore meant "TypeScript handlers that bothered
    // to annotate", and every JavaScript Lambda service extracted
    // nothing.
    //
    // The SAM template is the gate instead, and a better one, because it
    // names the handlers outright. `discoverUnits` looks each file up in
    // the template reachable from it, and a directory with no template
    // resolves to null once and stays memoized.

    terminals: [
      {
        // `return { statusCode, body, headers? }`, written at the return
        // site or built by a helper the adapter follows into. `body`
        // holds the serialized payload, so unwrap `JSON.stringify(x)` to
        // the shape of `x`.
        kind: "response",
        match: { type: "returnShape", requiredProperties: ["statusCode"] },
        extraction: {
          statusCode: { from: "property", name: "statusCode" },
          body: { from: "property", name: "body", unwrapJsonStringify: true },
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
