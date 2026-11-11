/**
 * A pack that recognizes a read of an object the runtime provides and
 * nothing declares:
 *
 *   process.env.TABLE_NAME ?? "accounts"
 *   requireEnv("TABLE_NAME")
 *   process.exitCode = 1
 *
 * A call chain starts at a receiver, and a read chain starts at the
 * object its reads are off. It says what a read of each entry is: a
 * config read, which pairs against whatever declares the entry, a
 * metadata read, or no read at all. DESIGN.md has the getters, the
 * helpers and the writes.
 */

import type {
  Chain,
  Deployment,
  EntryMeaning,
  GetterMeaning,
  Link,
  RuntimeReadEnding,
  WriteMeaning,
} from "./chain.js";
import type { RuntimeObject } from "./ops.js";

/** What a pack says about the object its reads are off. */
export interface RuntimeReadsSpec {
  /** The object the reads are off. */
  object: RuntimeObject;
  /** What the run says about the deployment a config read belongs to. A metadata read leaves it off. */
  deployment?: Deployment;
}

/** What one link of a read chain can say. */
export type ReadMeaning = EntryMeaning | GetterMeaning | WriteMeaning;

/** A chain over reads, and the links that can still be added. */
export interface RuntimeReads {
  /** What a read of each entry is. `otherwise` is any entry not listed; without it, an unlisted entry is no read. */
  entries(
    table: Readonly<Record<string, EntryMeaning>>,
    otherwise?: EntryMeaning,
  ): RuntimeReads;
  /** Methods that read one entry, with where the key and the fallback are. */
  getters(table: Readonly<Record<string, GetterMeaning>>): RuntimeReads;
  /** Entries whose assignment is a state change, and what an assignment to any other entry is. */
  writes(
    table: Readonly<Record<string, WriteMeaning>>,
    otherwise?: WriteMeaning,
  ): RuntimeReads;
  /** A call into a project function whose parameter supplies a read's key is a read at the call. */
  throughHelpers(): RuntimeReads;
  /** A line of code this matches, which the pack's tests run. */
  example(code: string): RuntimeReads;
  /** The links and the ending, as data. */
  readonly declared: Chain<ReadMeaning>;
}

/** A pack that recognizes reads off an object the runtime provides. */
export function runtimeReads(spec: RuntimeReadsSpec): RuntimeReads {
  const ending: RuntimeReadEnding = {
    yields: "runtimeRead",
    deployment: spec.deployment ?? {},
  };
  return chainFrom({
    links: [{ asks: "off", object: spec.object }],
    ending,
    example: null,
  });
}

/** The same chain with one more link, or with its example set. */
function chainFrom(declared: Chain<ReadMeaning>): RuntimeReads {
  const adding = (link: Link<ReadMeaning>): RuntimeReads =>
    chainFrom({ ...declared, links: [...declared.links, link] });

  return {
    declared,
    entries: (table, otherwise) =>
      adding({
        asks: "entries",
        table,
        ...(otherwise === undefined ? {} : { otherwise }),
      }),
    getters: (table) => adding({ asks: "getters", table }),
    writes: (table, otherwise) =>
      adding({
        asks: "writes",
        table,
        ...(otherwise === undefined ? {} : { otherwise }),
      }),
    throughHelpers: () => adding({ asks: "throughHelpers" }),
    example: (code) => chainFrom({ ...declared, example: code }),
  };
}
