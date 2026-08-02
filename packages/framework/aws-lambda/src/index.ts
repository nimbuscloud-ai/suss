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
// SQS / Schedule / SNS event handlers surface as `recognized-not-http`
// accounting units (see `discovery.ts`), and those read what they
// return under a wider terminal list (see `terminals.ts`). The
// message-bus pass in @suss/contract-cloudformation owns SQS consumers.

import { awsLambdaDiscovery } from "./discovery.js";
import { HTTP_TERMINALS } from "./terminals.js";

import type { PatternPack } from "@suss/extractor";
import type { SubjectFactory } from "./discovery.js";

export { awsLambdaDiscovery, METADATA_NAMESPACE } from "./discovery.js";
export { clearTemplateCache } from "./templateIndex.js";

export type { SubjectFactory } from "./discovery.js";

export interface AwsLambdaPackOptions {
  /**
   * Where a project's own handler factory states the subject its SQS
   * consumer expects. A handler built by such a factory gets a
   * message-bus binding on that subject instead of the fallback.
   *
   * The adapter follows the export back to the call that built it, so
   * an entry says which property carries the subject and nothing else:
   * `{ "property": "subject" }`. AWS declares no such factory and
   * nothing here names one, so a service that does not use this shape
   * is unaffected.
   */
  subjectFactories?: SubjectFactory[];
}

export function awsLambdaFramework(
  options: AwsLambdaPackOptions = {},
): PatternPack {
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
    discoverUnits: awsLambdaDiscovery(options.subjectFactories ?? []),

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

    // Route units extract against these. Non-HTTP accounting units carry
    // their own wider list, attached per unit by the discovery callback.
    terminals: HTTP_TERMINALS,

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
