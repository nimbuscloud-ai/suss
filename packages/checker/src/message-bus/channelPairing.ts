/**
 * An index over the channels on one side of a message bus.
 *
 * Splitting a channel into `${bus}#${subject}`, and deciding when two
 * channels pair, both live in @suss/ir-core. `boundaryKey` builds the
 * pairing key from the same split, and the generic pairing pass
 * compares buses with the same rule.
 */

import { busesAgree, parseChannel } from "@suss/ir-core";

export {
  channelsPair,
  formatChannel,
  type ParsedChannel,
  parseChannel,
} from "@suss/ir-core";

/**
 * The channels seen on one side of the bus, indexed by subject so a
 * lookup for a subject on an agreeing bus does not scan every channel.
 *
 * Each entry records the summary that added it, so a caller that finds
 * a pair can report which two summaries met.
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
