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
 *
 * Each entry remembers the summary that put it there, so a caller that
 * found a pair can say which two summaries met, and not only that
 * something did.
 */
export type ChannelSet = Map<string, ChannelEntry[]>;

interface ChannelEntry {
  bus: string | null;
  /** The id of the summary this channel came from. */
  owner: string;
}

export function createChannelSet(): ChannelSet {
  return new Map();
}

export function addChannel(
  set: ChannelSet,
  channel: string,
  owner: string,
): void {
  const { bus, subject } = parseChannel(channel);
  const entries = set.get(subject);
  if (entries === undefined) {
    set.set(subject, [{ bus, owner }]);
    return;
  }

  entries.push({ bus, owner });
}

/** The summaries in the set whose channel pairs with the given one. */
export function pairingOwners(set: ChannelSet, channel: string): string[] {
  const { bus, subject } = parseChannel(channel);
  const entries = set.get(subject);
  if (entries === undefined) {
    return [];
  }

  return entries
    .filter((entry) => busesAgree(entry.bus, bus))
    .map((entry) => entry.owner);
}

/** Whether any channel in the set pairs with the given channel. */
export function hasPair(set: ChannelSet, channel: string): boolean {
  return pairingOwners(set, channel).length > 0;
}
