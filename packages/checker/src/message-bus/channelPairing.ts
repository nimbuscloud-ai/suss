// channelPairing.ts: the message-bus side's index over channels.
//
// The split itself (`${bus}#${subject}`) and the rule for when two
// channels mean the same thing are shared comparison primitives owned
// by @suss/ir-core, because `boundaryKey` builds the pairing key from
// the same split and the generic pairing pass compares buses with the
// same rule. Re-exported here so this module's callers are unaffected
// by where they live.

import { busesAgree, parseChannel } from "@suss/ir-core";

export {
  channelsPair,
  formatChannel,
  type ParsedChannel,
  parseChannel,
} from "@suss/ir-core";

/**
 * The channels seen on one side of the bus, indexed by subject so a
 * lookup can ask "is anything here using this subject on an agreeing
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
