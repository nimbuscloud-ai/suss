/**
 * The calls that reach a Lambda by name.
 *
 * The template says which events reach a function and nothing in it
 * says which function calls which, so this reads that off the code:
 *
 *   client.send(new InvokeCommand({
 *     FunctionName: process.env.WORKER_FUNCTION,
 *     Payload: JSON.stringify({ orderId }),
 *   }));
 *
 * The README says how a name written as an env var or an ARN meets the
 * function the template declares.
 */

import { constructedFrom, unitInvokes } from "@suss/recognize";

import type { Match } from "@suss/recognize";

const LAMBDA = "@aws-sdk/client-lambda";

/** Where an invoke states its request: one argument into the command. */
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
 * The two invoke commands. They spell the payload differently, which is
 * a fact about each command rather than a setting on one declaration,
 * so each gets its own.
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
