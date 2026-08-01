// terminals.ts holds the terminal lists this pack extracts against.
//
// Two lists because the pack discovers two kinds of unit. Route units
// answer HTTP, so they get the envelope shapes and nothing else: a
// return the envelope does not describe stays an unread return, which
// is the signal that a handler answered in a shape nobody taught the
// pack. Non-HTTP units (SQS / Schedule / SNS handlers, surfaced as
// `recognized-not-http`) answer whatever their trigger accepts, so
// there is no envelope to hold them to; those additionally read any
// returned object outright.

import type { TerminalPattern } from "@suss/extractor";

/** What an HTTP route unit can produce. */
export const HTTP_TERMINALS: TerminalPattern[] = [
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
    // `return { batchItemFailures }`, which is how a consumer tells
    // Lambda which records to retry and which to drop. Lambda
    // defines the shape, so this pack can name it, the same way it
    // names the HTTP envelope above.
    kind: "return",
    match: {
      type: "returnShape",
      requiredProperties: ["batchItemFailures"],
    },
    extraction: {},
  },
  {
    // `throw new SomeError(...)`. An uncaught throw becomes a
    // throw-output transition; API Gateway maps it to a 5xx, but the
    // specific status is the platform's, not the handler's.
    kind: "throw",
    match: { type: "throwExpression" },
    extraction: {},
  },
];

/**
 * What a non-HTTP unit can produce: everything above, plus any object
 * the handler returns. A scheduled job answers its invoker with an
 * arbitrary summary object, and no envelope constrains it, so the
 * shape written at the return site is the output worth reading.
 *
 * The named shapes stay first because the matcher takes the first
 * pattern that fits a node, so anything they described before is
 * described the same way now. The unqualified `returnShape` only picks
 * up returns that previously went unread, and only when they return an
 * object (directly or through a project-local helper). A return of a
 * variable or a library call still surfaces as an unread return.
 *
 * Route units must never get this list. An earlier version put an
 * unqualified return terminal on the whole pack, and it produced a
 * phantom transition on ternary envelope returns and swallowed the
 * unread-return signal for every HTTP handler.
 */
export const NON_HTTP_TERMINALS: TerminalPattern[] = [
  ...HTTP_TERMINALS,
  {
    kind: "return",
    match: { type: "returnShape" },
    extraction: {},
  },
  {
    // A queue consumer answers by not throwing: it processes the batch
    // and falls off the end, and Lambda takes the absence of an error
    // as the ack. Without this the handler has no terminal at all, so
    // it carries no transition, and everything it does — the queue it
    // writes to, the table it reads — goes with it.
    kind: "return",
    match: { type: "functionFallthrough" },
    extraction: {},
  },
];
