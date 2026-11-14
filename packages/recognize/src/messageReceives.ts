/**
 * A pack that recognizes a handler reading a message out of what the
 * platform hands it, as the decode of the payload:
 *
 *   for (const record of event.Records) { const order = JSON.parse(record.body); }
 *   order = json.loads(record["body"])
 *
 * The pack says the wire, the encoding, and the path from what the
 * platform hands the unit to the encoded payload. A receive pairs with
 * the sends on the queue the deployment says the unit drains, so the
 * chain has no channel, and it doesn't start at a receiver.
 */

import type { MessageBusSemantics } from "@suss/behavioral-ir";
import type {
  Chain,
  Envelope,
  MessageReceiveEnding,
  MethodMeaning,
} from "./chain.js";

export interface MessageReceivesSpec {
  /** The wire, in the words the IR's message-bus semantics use. */
  wire: MessageBusSemantics["messageBus"];
  /** The encoding the payload is written in, which picks the decoder a receive is read at. */
  codec: string;
  /** The ways the program reaches the encoded payload, tried in order. */
  envelope: readonly Envelope[];
}

/** A chain over receives, and the links that can still be added. */
export interface MessageReceives {
  /** A line of code this matches, which the pack's tests run. */
  example(code: string): MessageReceives;
  /** The ending, as data. */
  readonly declared: Chain<MethodMeaning>;
}

/** A pack that recognizes a handler decoding a message it was handed. */
export function messageReceives(spec: MessageReceivesSpec): MessageReceives {
  const ending: MessageReceiveEnding = {
    yields: "messageReceive",
    wire: spec.wire,
    codec: spec.codec,
    envelope: spec.envelope,
  };
  return chainFrom({ links: [], ending, example: null });
}

function chainFrom(declared: Chain<MethodMeaning>): MessageReceives {
  return {
    declared,
    example: (code) => chainFrom({ ...declared, example: code }),
  };
}
