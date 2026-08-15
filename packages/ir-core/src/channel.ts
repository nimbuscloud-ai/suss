/**
 * Deciding when two message-bus channel strings mean the same thing.
 *
 * A channel is a subject, optionally qualified by the bus that carries
 * it, written `${bus}#${subject}`. The two sides of a pairing rarely
 * know the same amount, so they pair on the subject and the buses have
 * to agree only when both sides know one. The package README works
 * through why, with examples.
 *
 * Everything that writes or reads that string goes through
 * `formatChannel` and `parseChannel`, so the wire format has a single
 * author. A template reader that hand-writes the `#` would be a second
 * author, and the two would drift the first time either one changed.
 */

/** A channel string, written `${bus}#${subject}`, split into its two parts. */
export interface ParsedChannel {
  bus: string | null;
  subject: string;
}

export function parseChannel(channel: string): ParsedChannel {
  const hash = channel.indexOf("#");
  if (hash === -1) {
    return { bus: null, subject: channel };
  }
  return { bus: channel.slice(0, hash), subject: channel.slice(hash + 1) };
}

declare const ChannelBrand: unique symbol;

/**
 * `bus#subject`, or the bare subject when no source said the bus. The
 * unqualified form is legal, so fields keep the type string and the
 * mint is the whole win: a channel assembled by hand cannot claim the
 * brand, and the format has one spelling (#167).
 */
export type Channel = string & { readonly [ChannelBrand]: "channel" };

export function formatChannel(bus: string | null, subject: string): Channel {
  if (bus === null) {
    return subject as Channel;
  }
  return `${bus}#${subject}` as Channel;
}

export function busesAgree(a: string | null, b: string | null): boolean {
  return a === null || b === null || a === b;
}

export function channelsPair(a: string, b: string): boolean {
  const left = parseChannel(a);
  const right = parseChannel(b);
  return left.subject === right.subject && busesAgree(left.bus, right.bus);
}
