/**
 * Recognizes calls that invoke a Lambda by name. The template lists the
 * events that reach a function but not which function calls which, so
 * the pack reads that from the code:
 *
 *   client.send(new InvokeCommand({
 *     FunctionName: process.env.WORKER_FUNCTION,
 *     Payload: JSON.stringify({ orderId }),
 *   }));
 *
 * The README explains how a name written as an env var or an ARN is
 * matched to the function the template declares.
 */

import { constructedFrom, unitInvokes } from "@suss/recognize";

import type { Match } from "@suss/recognize";

const LAMBDA = "@aws-sdk/client-lambda";

/** An invoke's request is the first argument to the command constructor. */
const INSIDE_THE_COMMAND = (named: string[]) => ({
  send: {
    input: {
      at: 0,
      of: [
        {
          to: "argument" as const,
          at: 0,
          origin: constructedFrom({ from: [LAMBDA], named }),
        },
      ],
    },
  },
});

/**
 * The two invoke commands put the payload under different keys, so each
 * command gets its own declaration.
 */
export function invokeDeclarations(): Match[] {
  return [
    unitInvokes({
      platform: "lambda",
      client: constructedFrom(LAMBDA),
      named: ["FunctionName"],
      payload: "Payload",
    })
      .methods(INSIDE_THE_COMMAND(["InvokeCommand"]))
      .example(
        'client.send(new InvokeCommand({ FunctionName: "Worker", Payload: "{}" }))',
      ),
    unitInvokes({
      platform: "lambda",
      client: constructedFrom(LAMBDA),
      named: ["FunctionName"],
      payload: "InvokeArgs",
    })
      .methods(INSIDE_THE_COMMAND(["InvokeAsyncCommand"]))
      .example(
        'client.send(new InvokeAsyncCommand({ FunctionName: "Worker", InvokeArgs: "{}" }))',
      ),
  ];
}
