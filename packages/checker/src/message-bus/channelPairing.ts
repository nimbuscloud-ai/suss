// channelPairing.ts — decide when two message-bus channel strings name
// the same thing.
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
// forced to invent one: the code pack reads `expected: 'order.placed'`
// off a handler's config, while which bus reaches that handler is
// deployment configuration the code never names.

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

/** Two buses agree when they are the same, or when either is unknown. */
function busesAgree(a: string | null, b: string | null): boolean {
  return a === null || b === null || a === b;
}

/** Whether two channels name the same subject on agreeing buses. */
export function channelsPair(a: string, b: string): boolean {
  const left = parseChannel(a);
  const right = parseChannel(b);
  return left.subject === right.subject && busesAgree(left.bus, right.bus);
}

/**
 * The channels seen on one side of the bus, indexed by subject so a
 * lookup asks "does anything here carry this subject on an agreeing
 * bus?" without scanning every channel.
 */
export type ChannelSet = Map<string, (string | null)[]>;

export function createChannelSet(): ChannelSet {
  return new Map();
}

export function addChannel(set: ChannelSet, channel: string): void {
  const { bus, subject } = parseChannel(channel);
  const buses = set.get(subject);
  if (buses === undefined) {
    set.set(subject, [bus]);
    return;
  }

  buses.push(bus);
}

/** Whether any channel in the set pairs with the given channel. */
export function hasPair(set: ChannelSet, channel: string): boolean {
  const { bus, subject } = parseChannel(channel);
  const buses = set.get(subject);
  if (buses === undefined) {
    return false;
  }

  return buses.some((candidate) => busesAgree(candidate, bus));
}
