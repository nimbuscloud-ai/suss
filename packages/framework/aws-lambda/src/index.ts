/**
 * Pattern pack for AWS Lambda handlers. The SAM or CloudFormation
 * template declares which routes and events reach a handler, and the
 * code shows what the handler returns. The pack extracts the code side
 * and gives each route unit the same `(method, normalizedPath)` binding
 * the declared route has, so the two pair.
 *
 * Handlers are found from the template: each Serverless::Function's
 * `Handler` is resolved back to a source file and an export. A handler
 * that an SQS, Schedule or SNS event reaches becomes a
 * `recognized-not-http` accounting unit, and SQS consumers pair through
 * the message-bus pass in @suss/contract-cloudformation. The README
 * covers response helpers and why the pack has no import gate.
 */

import { z } from "zod";

import { compile, declarationsIn } from "@suss/recognize";

import { awsLambdaDiscovery } from "./discovery.js";
import { invokeDeclarations } from "./invokes.js";
import { templatesForFiles } from "./templateIndex.js";
import { HTTP_TERMINALS } from "./terminals.js";

import type { PatternPack } from "@suss/extractor";
import type { PackDeclaration } from "@suss/ir-core";

export { awsLambdaDiscovery, METADATA_NAMESPACE } from "./discovery.js";
export { clearTemplateCache } from "./templateIndex.js";

/**
 * The pack reads everything from the template or the code, so it takes
 * no options and the CLI refuses any key in a config file.
 */
export const optionsSchema = z.object({}).strict();

export type AwsLambdaPackOptions = z.infer<typeof optionsSchema>;

export function awsLambdaFramework(
  _options: AwsLambdaPackOptions = {},
): PatternPack {
  const invokes = invokeDeclarations();
  return {
    name: "aws-lambda",
    protocol: "http",
    // The adapter cannot read Sentry's wrapper inside the library, so the
    // pack declares that the handler is argument 0. A wrapper written in
    // the project needs no entry, because the adapter reads its body.
    transparentWrappers: [
      { module: "@sentry/aws-serverless", name: "wrapHandler", argument: 0 },
    ],
    languages: ["typescript", "javascript"],

    // The routing is in the template, so the callback finds handlers
    // there and the pattern list stays empty.
    discovery: [],
    discoverUnits: awsLambdaDiscovery(),

    // Discovery reads the templates, so they go into the cache key and an
    // edited template makes the next run read the project again.
    discoveryInputs: templatesForFiles,

    // No import gate: a JavaScript handler imports nothing from
    // `aws-lambda`, so the template acts as the gate. See the README.

    // A unit that is not HTTP gets a longer list from the discovery
    // callback in place of this one.
    terminals: HTTP_TERMINALS,

    inputMapping: {
      type: "positionalParams",
      params: [
        { position: 0, role: "event" },
        { position: 1, role: "context" },
      ],
    },

    // A proxy integration passes the handler API Gateway's event, with the
    // body as a string the handler parses. A read of the body records that
    // the handler took all of it, with no field name.
    requestSpelling: {
      headers: { path: ["event", "headers"], saysWhichField: true },
      query: {
        path: ["event", "queryStringParameters"],
        saysWhichField: true,
      },
      params: { path: ["event", "pathParameters"], saysWhichField: true },
      body: { path: ["event", "body"], saysWhichField: false },
    },

    // Powertools reads these variables from inside node_modules, where no
    // walk over the project goes, so without this entry they look unread.
    libraryEnvVars: [
      {
        module: "@aws-lambda-powertools/",
        prefixes: ["POWERTOOLS_"],
      },
    ],

    // A pack-level `requiresImport` would gate `discoverUnits` too. Each
    // declaration already checks which SDK its command class came from.
    invocationRecognizers: invokes.map((match) =>
      compile(match.declared, "@suss/framework-aws-lambda"),
    ),
    declarations: declarationsIn(invokes),
  };
}

export const declares: PackDeclaration = {
  kind: "framework",
  package: "@suss/framework-aws-lambda",
  dependencies: [{ ecosystem: "npm", name: "@types/aws-lambda" }],
  reads:
    "AWS Lambda HTTP handlers, paired with the routes a SAM or CloudFormation template declares.",
};

export default awsLambdaFramework;
