/**
 * The entry point for a pack that recognizes storage calls, and the
 * chain it builds.
 *
 * The entry point says what comes out rather than how, so a pack author
 * writes `storageCalls` and never meets an `Effect`. Each method on the
 * returned value adds one link and gives back a new chain, so a chain
 * is finished data by the time `pack` receives it.
 */

import { chainStart } from "./chain.js";

import type {
  ArgumentPick,
  CallStep,
  Chain,
  Link,
  LinkFunction,
  OneArgument,
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
  /**
   * How the pack pins down the client its calls are on. A pack that
   * matches a helper a project lists in its own config leaves this out,
   * because the name that project gave is the whole of what it has.
   */
  client?: ReceiverOrigin;
  /**
   * What a reader gives back for a name nothing settles. Defaults to
   * "reference", which says which value to go and ask about.
   */
  unsettledName?: "nothing" | "reference";
}

/** A storage chain, and the links that can still be added to it. */
export interface StorageCalls {
  /**
   * Which call the chain is about, when it is not the one in hand. The
   * steps run from the call in hand, and every other link is asked of
   * what they reach.
   */
  about(...of: readonly CallStep[]): StorageCalls;
  /** Which methods count, and what each one reads or writes. */
  methods(
    table: Readonly<Record<string, StorageMethod>>,
    options?: { ignoringCase?: boolean },
  ): StorageCalls;
  /**
   * Which container a call's selector belongs to, as an argument or as
   * the pack's own rule. Without this the first name a call reached is
   * the container.
   */
  container(
    says:
      | ArgumentPick
      | LinkFunction<[readonly string[], CallOps], string | null>,
  ): StorageCalls;
  /** Which way into the container the call took, when it states one. */
  accessPath(says: ArgumentPick): StorageCalls;
  /**
   * Where a call that reaches several containers at once states them.
   * Each entry becomes one effect, against the container its key says.
   */
  containersIn(says: OneArgument): StorageCalls;
  /**
   * Where a call states its inputs, when it states them as one object.
   * A call that states none does not match, and a rule the pack wrote
   * over the inputs is handed the object.
   */
  input(says: OneArgument): StorageCalls;
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
  const client = spec.client;
  return chainFrom({
    links: chainStart(client),
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
    about: (...of) => adding({ asks: "subject", of }),
    methods: (table, options) =>
      adding({
        asks: "methods",
        table,
        ignoringCase: options?.ignoringCase ?? false,
      }),
    container: (says) =>
      adding(
        typeof says === "function"
          ? { asks: "container", from: says }
          : { asks: "container", argument: says },
      ),
    accessPath: (says) => adding({ asks: "accessPath", argument: says }),
    containersIn: (says) => adding({ asks: "containers", in: says }),
    input: (says) => adding({ asks: "input", at: says }),
    example: (code) => chainFrom({ ...declared, example: code }),
  };
}
