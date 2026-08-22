/**
 * The entry point for a pack that recognizes storage calls, and the
 * chain it builds.
 *
 * The entry point says what comes out rather than how, so a pack author
 * writes `storageCalls` and never meets an `Effect`. Each method on the
 * returned value adds one link and gives back a new chain, so a chain
 * is finished data by the time `pack` receives it.
 */

import type {
  Chain,
  Link,
  LinkFunction,
  StorageEnding,
  StorageMethod,
} from "./chain.js";
import type { CallOps, ReceiverOrigin } from "./ops.js";

/** What a pack says about the store its calls reach. */
export interface StorageCallsSpec {
  /** The store, in the words OpenTelemetry's semantic conventions use. */
  system: string;
  /** The wire, when it differs from the store's own name. */
  transport?: string;
  /** Which of the store's namespaces the calls reach. Defaults to "default". */
  scope?: string;
  /** How the pack pins down the client its calls are on. */
  client: ReceiverOrigin;
  /**
   * What a reader gives back for a name nothing settles. Defaults to
   * "reference", which says which value to go and ask about.
   */
  unsettledName?: "nothing" | "reference";
}

/** A storage chain, and the links that can still be added to it. */
export interface StorageCalls {
  /** Which methods count, and what each one reads or writes. */
  methods(
    table: Readonly<Record<string, StorageMethod>>,
    options?: { ignoringCase?: boolean },
  ): StorageCalls;
  /**
   * Which container a call's selector belongs to. Without this the
   * first name a call reached is the container.
   */
  container(
    from: LinkFunction<[readonly string[], CallOps], string | null>,
  ): StorageCalls;
  /** A line of code this matches, which the pack's tests run. */
  example(code: string): StorageCalls;
  /** The links and the ending, as data. */
  readonly declared: Chain<StorageMethod>;
}

/** A pack that recognizes calls against a store. */
export function storageCalls(spec: StorageCallsSpec): StorageCalls {
  const ending: StorageEnding = {
    yields: "storageAccess",
    system: spec.system,
    ...(spec.transport === undefined ? {} : { transport: spec.transport }),
    scope: spec.scope ?? "default",
    unsettledName: spec.unsettledName ?? "reference",
  };
  return chainFrom({
    links: [{ asks: "start", at: { starts: "receiver", origin: spec.client } }],
    ending,
    example: null,
  });
}

/** The same chain with one more link, or with its example set. */
function chainFrom(declared: Chain<StorageMethod>): StorageCalls {
  const adding = (link: Link<StorageMethod>): StorageCalls =>
    chainFrom({ ...declared, links: [...declared.links, link] });

  return {
    declared,
    methods: (table, options) =>
      adding({
        asks: "methods",
        table,
        ignoringCase: options?.ignoringCase ?? false,
      }),
    container: (from) => adding({ asks: "container", from }),
    example: (code) => chainFrom({ ...declared, example: code }),
  };
}
