/**
 * A pack that recognizes a write to one of the process's own output
 * streams, which the runtime provides and nothing declares:
 *
 *   console.error("failed")
 *   process.stdout.write(`${JSON.stringify(report)}\n`)
 *
 * The client is a `global` the source spells, or a value of one of the
 * runtime's types. Each method says which stream it writes to, or that
 * it writes to the stream it is called on, and `streams` says which
 * stream each spelling of a receiver is.
 */

import { chainStart } from "./chain.js";

import type {
  Chain,
  Link,
  StreamWriteEnding,
  StreamWriteMethod,
} from "./chain.js";
import type { ReceiverOrigin } from "./ops.js";

export interface StreamWritesSpec {
  /** Each global path a receiver can be, and the stream it is. */
  streams: Readonly<Record<string, string>>;
  /** How the pack pins down the stream or the object that writes to one. */
  client: ReceiverOrigin;
}

/** A chain over stream writes, and the links that can still be added. */
export interface StreamWrites {
  /** Which methods write, and to which stream. */
  methods(table: Readonly<Record<string, StreamWriteMethod>>): StreamWrites;
  /** A line of code this matches, which the pack's tests run. */
  example(code: string): StreamWrites;
  /** The links and the ending, as data. */
  readonly declared: Chain<StreamWriteMethod>;
}

/** A pack that recognizes writes to the process's output streams. */
export function streamWrites(spec: StreamWritesSpec): StreamWrites {
  const ending: StreamWriteEnding = {
    yields: "streamWrite",
    streams: spec.streams,
  };
  return chainFrom({
    links: chainStart(spec.client),
    ending,
    example: null,
  });
}

/** The same chain with one more link, or with its example set. */
function chainFrom(declared: Chain<StreamWriteMethod>): StreamWrites {
  const adding = (link: Link<StreamWriteMethod>): StreamWrites =>
    chainFrom({ ...declared, links: [...declared.links, link] });

  return {
    declared,
    methods: (table) => adding({ asks: "methods", table, ignoringCase: false }),
    example: (code) => chainFrom({ ...declared, example: code }),
  };
}
