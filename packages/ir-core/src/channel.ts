/**
 * When two message-bus channel strings mean the same channel.
 *
 * A channel is a subject, optionally qualified by the bus it travels
 * on, written `${bus}#${subject}`. The two sides of a pairing rarely
 * know the same amount, so they pair on the subject, and the buses have
 * to match only when both sides know one. The package README explains
 * why, with examples.
 *
 * All code that writes or reads the string goes through `formatChannel`
 * and `parseChannel`. A template reader that wrote the `#` by hand would
 * drift from them the first time either one changed.
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
 * `bus#subject`, or the bare subject when no source gave the bus.
 *
 * Fields that store a channel stay typed as `string`, since a bare
 * subject is legal there. The brand exists so that a `Channel` value
 * can only come from `formatChannel` and never from a string built by
 * hand (#167).
 */
export type Channel = string & { readonly [ChannelBrand]: "channel" };

export function formatChannel(bus: string | null, subject: string): Channel {
  if (bus === null) {
    return subject as Channel;
  }
  return `${bus}#${subject}` as Channel;
}

/** A side that does not know its bus agrees with any bus. */
export function busesAgree(a: string | null, b: string | null): boolean {
  return a === null || b === null || a === b;
}

export function channelsPair(a: string, b: string): boolean {
  const left = parseChannel(a);
  const right = parseChannel(b);
  return left.subject === right.subject && busesAgree(left.bus, right.bus);
}
