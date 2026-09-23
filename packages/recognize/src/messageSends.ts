/**
 * A pack that recognizes a call putting a message on a wire.
 *
 * It was written against the AWS SDK. There an operation is a command
 * class and its arguments are one object, so the pack says which
 * command, where the message is inside it, and which of the message's
 * properties make up the channel:
 *
 *   client.send(new SendMessageCommand({ QueueUrl, MessageBody }))
 *   client.send(new PutEventsCommand({ Entries: [{ EventBusName, DetailType }] }))
 *
 * A library that sends one message and a batch through separate
 * commands gets two declarations, one per command.
 */

import { chainStart } from "./chain.js";

import type { MessageBusSemantics } from "@suss/behavioral-ir";
import type {
  Chain,
  ChannelPart,
  Link,
  MessageLocation,
  MessageSendEnding,
  MessageSendMethod,
} from "./chain.js";
import type { ReceiverOrigin, UnsettledName } from "./ops.js";

export interface MessageSendsSpec {
  /** The wire, in the words the IR's message-bus semantics use. */
  wire: MessageBusSemantics["messageBus"];
  /** Where the messages are: the call's input, or a property holding many. */
  messages: MessageLocation;
  /** The parts of the channel, joined in the order they are written. */
  channel: readonly ChannelPart[];
  /** What joins the parts. Defaults to "#", as used between a bus and a subject. */
  channelSeparator?: string;
  /** The property a message states its body on. */
  body?: string;
  /**
   * The property whose literal value is recorded as the routing key. A
   * reader can filter on it, and it stays out of the channel name.
   */
  routingKey?: string;
  /**
   * What a reader gives back for a channel nothing in the source
   * settles. Defaults to keeping the reference, because most queues get
   * their name at deploy time.
   */
  unsettledName?: UnsettledName;
  /** How the pack pins down the client its calls are on. */
  client?: ReceiverOrigin;
}

/** A chain over sends, and the links that can still be added. */
export interface MessageSends {
  /** Which methods send, and where each one states the message. */
  methods(
    table: Readonly<Record<string, MessageSendMethod>>,
    options?: { ignoringCase?: boolean },
  ): MessageSends;
  /** A line of code this matches, which the pack's tests run. */
  example(code: string): MessageSends;
  /** The links and the ending, as data. */
  readonly declared: Chain<MessageSendMethod>;
}

/** A pack that recognizes a call sending a message. */
export function messageSends(spec: MessageSendsSpec): MessageSends {
  const ending: MessageSendEnding = {
    yields: "messageSend",
    wire: spec.wire,
    messages: spec.messages,
    channel: spec.channel,
    ...(spec.channelSeparator === undefined
      ? {}
      : { channelSeparator: spec.channelSeparator }),
    ...(spec.body === undefined ? {} : { body: spec.body }),
    ...(spec.routingKey === undefined ? {} : { routingKey: spec.routingKey }),
    unsettledName: spec.unsettledName ?? "reference",
  };
  return chainFrom({
    links: chainStart(spec.client),
    ending,
    example: null,
  });
}

/** The same chain with one more link, or with its example set. */
function chainFrom(declared: Chain<MessageSendMethod>): MessageSends {
  const adding = (link: Link<MessageSendMethod>): MessageSends =>
    chainFrom({ ...declared, links: [...declared.links, link] });

  return {
    declared,
    methods: (table, options) =>
      adding({
        asks: "methods",
        table,
        ignoringCase: options?.ignoringCase ?? false,
      }),
    example: (code) => chainFrom({ ...declared, example: code }),
  };
}
