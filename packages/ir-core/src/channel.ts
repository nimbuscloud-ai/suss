// channel.ts: deciding when two message-bus channel strings name the
// same thing.
//
// A channel is a subject, optionally qualified by the bus that carries
// it, written `${bus}#${subject}`. The two sides of a pairing do not
// always know the same amount:
//
//   template producer   default#order.placed
//   template consumer   default#order.placed     pair, bus included
//   code consumer       order.placed             pairs with either
//                       staging#order.placed     does not pair
//
// So channels pair on the subject, and the bus has to agree only when
// both sides carry one. A side that knows its bus keeps that
// precision, because two buses routing the same detail-type are
// different destinations and the CloudFormation contract goes out of
// its way to tell them apart. A side that cannot know the bus is not
// forced to invent one: the code pack reads `subject: 'order.placed'`
// off a handler's config, while which bus reaches that handler is
// deployment configuration the code never names.
//
// This sits next to `boundaryKey` because the key is built from the
// same split: the key carries the subject, so both written forms land
// in one bucket, and `channelsPair` compares the buses inside it.

/**
 * A channel split into the bus that carries it and the subject on that
 * bus. `default#order.placed` is the subject `order.placed` on the bus
 * `default`. `OrdersQueue` is a subject with no bus, which is what a
 * queue's logical id and an env-var-named channel look like.
 */
export interface ParsedChannel {
  bus: string | null;
  subject: string;
}

/**
 * Split a channel on its first `#`. Later `#`s stay in the subject, so
 * a subject that contains one is compared whole rather than being cut
 * into pieces that pair with the wrong things.
 */
export function parseChannel(channel: string): ParsedChannel {
  const hash = channel.indexOf("#");
  if (hash === -1) {
    return { bus: null, subject: channel };
  }
  return { bus: channel.slice(0, hash), subject: channel.slice(hash + 1) };
}

/**
 * Write a bus and a subject as one channel string, the form
 * `parseChannel` reads back. A side that does not know its bus passes
 * null and gets the subject alone.
 *
 * Anything that mints a channel comes through here, so the wire format
 * has one author. A template reader that hand-writes the `#` is a
 * second author, and the two drift the first time either changes.
 */
export function formatChannel(bus: string | null, subject: string): string {
  if (bus === null) {
    return subject;
  }
  return `${bus}#${subject}`;
}

/** Two buses agree when they are the same, or when either is unknown. */
export function busesAgree(a: string | null, b: string | null): boolean {
  return a === null || b === null || a === b;
}

/** Whether two channels name the same subject on agreeing buses. */
export function channelsPair(a: string, b: string): boolean {
  const left = parseChannel(a);
  const right = parseChannel(b);
  return left.subject === right.subject && busesAgree(left.bus, right.bus);
}
