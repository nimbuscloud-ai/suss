/**
 * The pack discovers two kinds of unit, so it has two terminal lists. A
 * route unit responds over HTTP and gets only the envelope patterns. A
 * return the envelope does not describe stays an unread return, which
 * shows that the handler returned something the pack does not cover.
 *
 * A unit that is not HTTP (an SQS, Schedule or SNS handler, reported as
 * `recognized-not-http`) can return whatever its trigger accepts, and
 * there is no envelope to check it against. Its list also reads any
 * object the handler returns.
 */

import type { TerminalPattern } from "@suss/extractor";

export const HTTP_TERMINALS: TerminalPattern[] = [
  {
    // `return { statusCode, body, headers? }`, at the return or in a helper
    // the adapter follows. `body` contains the serialized payload, so
    // `JSON.stringify(x)` is unwrapped to the shape of `x`.
    kind: "response",
    match: { type: "returnShape", requiredProperties: ["statusCode"] },
    extraction: {
      statusCode: { from: "property", name: "statusCode" },
      body: { from: "property", name: "body", unwrapJsonStringify: true },
    },
  },
  {
    // `return { batchItemFailures }` makes Lambda retry the records it
    // lists. Lambda defines this shape, so the pack can match on it the
    // same way it matches the envelope above.
    kind: "return",
    match: {
      type: "returnShape",
      requiredProperties: ["batchItemFailures"],
    },
    extraction: {},
  },
  {
    // An uncaught throw becomes a throw-output transition. API Gateway
    // turns it into a 5xx, and the platform picks which one.
    kind: "throw",
    match: { type: "throwExpression" },
    extraction: {},
  },
];

/**
 * Everything above, plus any object the handler returns. A scheduled job
 * can hand back any summary object, so what it returns is worth reading.
 *
 * The named shapes stay first because the matcher takes the first pattern
 * that fits, so they describe a return the same way on both lists. The
 * bare `returnShape` catches only an object returned directly or through
 * a project helper. A returned variable or library call still shows up as
 * an unread return.
 *
 * A route unit must never get this list. The bare pattern would add a
 * spurious transition on a ternary envelope return, and it would hide
 * every unread return from an HTTP handler.
 */
export const NON_HTTP_TERMINALS: TerminalPattern[] = [
  ...HTTP_TERMINALS,
  {
    kind: "return",
    match: { type: "returnShape" },
    extraction: {},
  },
  {
    // A queue consumer acknowledges a batch by returning without an error.
    // Without this pattern the handler has no terminal, so it gets no
    // transition and everything it does is lost with it.
    kind: "return",
    match: { type: "functionFallthrough" },
    extraction: {},
  },
];
