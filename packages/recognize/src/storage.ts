/**
 * The entry point for a pack that recognizes storage calls, and the
 * chain it builds.
 *
 * A pack author writes `storageCalls` and never builds an `Effect` by
 * hand. Each method on the returned value adds one link and returns a
 * new chain, so by the time `pack` receives a chain it is plain data
 * that nothing changes afterwards.
 */

import { chainStart } from "./chain.js";

import type {
  ArgumentPick,
  CallStep,
  Chain,
  ClassPick,
  ContainerMember,
  DeclaredSlots,
  Link,
  LinkFunction,
  Naming,
  OneArgument,
  RelatedAccess,
  StatedInputs,
  StorageEnding,
  StorageMethod,
  StorageSystem,
  SubjectLink,
} from "./chain.js";
import type { CallOps, ReceiverOrigin } from "./ops.js";

/** What a pack says about the store its calls reach. */
export interface StorageCallsSpec {
  /**
   * The store, in the words OpenTelemetry's semantic conventions use, or
   * a rule that reads it from the project each call's file belongs to.
   */
  system: StorageSystem;
  /** The wire, when it differs from the store's own name. */
  transport?: string;
  /** Which of the store's namespaces the calls reach. Defaults to "default". */
  scope?: string;
  /**
   * How the pack pins down the client its calls are on. A pack that
   * matches a helper listed in a project's own config leaves this out,
   * because the helper's name is the only thing it has to match on.
   */
  client?: ReceiverOrigin;
  /**
   * The steps from the call in hand to the one whose receiver is the
   * client, when the client is further along than the call's own
   * receiver: `[{ to: "member" }]` for `db.user.findMany()`.
   */
  clientAt?: readonly CallStep[];
  /**
   * What a reader gives back for a name nothing settles. Defaults to
   * "reference", which says which value to go and ask about.
   */
  unsettledName?: "nothing" | "reference";
}

/** The container as the member the steps reach, spelled through a naming. */
export interface MemberContainer {
  of: readonly CallStep[];
  naming?: Naming;
}

/** Every form `container` takes. */
type ContainerSays =
  | ArgumentPick
  | readonly ArgumentPick[]
  | MemberContainer
  | ClassPick
  | LinkFunction<[readonly string[], CallOps], string | null>;

/** Which calls in hand a chain about another call reads. */
export interface AboutOptions {
  /** The methods the call in hand may be. Any other call is not read. */
  calledAs: readonly string[];
}

/** A storage chain, and the links that can still be added to it. */
export interface StorageCalls {
  /**
   * Which call the chain is about, when it is not the one in hand. The
   * steps run from the call in hand, and every other link is asked of
   * what they reach. Options after the steps say which calls in hand
   * count.
   */
  about(
    ...of: readonly CallStep[] | readonly [...CallStep[], AboutOptions]
  ): StorageCalls;
  /**
   * Which methods count, and what each one reads or writes. With `of`,
   * the method is the one the call those steps reach makes.
   */
  methods(
    table: Readonly<Record<string, StorageMethod>>,
    options?: { ignoringCase?: boolean; of?: readonly CallStep[] },
  ): StorageCalls;
  /**
   * What every method the table leaves out does, on a receiver the
   * start accepts. A session whose other methods all read lists its
   * writes and reads the rest here.
   */
  otherwise(meaning: StorageMethod): StorageCalls;
  /**
   * What a bare call of the client itself does. A store hook such as
   * `useAppStore((s) => s.bears)` calls no method, so this meaning
   * applies to every call.
   */
  calls(meaning: StorageMethod): StorageCalls;
  /**
   * Which container a call's selector belongs to, as an argument, as the
   * member the call is made on, or as the pack's own rule. Without this
   * the first name a call reached is the container. A list of arguments
   * is tried in order until one reaches a name.
   */
  container(
    says: ContainerSays,
    options?: { qualified?: boolean },
  ): StorageCalls;
  /**
   * Where a call states the accesses it makes through the container's
   * relations, and the rule that reads them. Each one becomes an effect
   * of its own after the container's.
   */
  relations(says: {
    of: OneArgument;
    by: LinkFunction<[StatedInputs], readonly RelatedAccess[]>;
  }): StorageCalls;
  /** Which way into the container the call took, when it states one. */
  accessPath(says: ArgumentPick): StorageCalls;
  /**
   * Which namespace the call reached, when the call says rather than
   * the pack. Without this every access records the scope the chain
   * was built with.
   */
  scope(says: ArgumentPick): StorageCalls;
  /**
   * Where a call that reaches several containers at once states them.
   * Each entry becomes one effect, against the container its key says,
   * or against the name itself where the call lists names alone.
   */
  containersIn(
    says: OneArgument,
    options?: { each?: "entry" | "name" },
  ): StorageCalls;
  /**
   * Where a call states its inputs, when it states them as one object.
   * A call that states none does not match, and a rule the pack wrote
   * over the inputs is handed the object.
   */
  input(says: OneArgument): StorageCalls;
  /**
   * Where a call states the value for each column, as paths under its
   * input, or `"none"` when its calls state none. Without this the
   * slots are the values the pack's rules read under each column's name.
   */
  slots(says: DeclaredSlots | "none"): StorageCalls;
  /** A line of code this matches, which the pack's tests run. */
  example(code: string): StorageCalls;
  /** The links and the ending, as data. */
  readonly declared: Chain<StorageMethod>;
}

/** Which calls in hand a chain reads, beyond what its links say. */
export interface StorageCallsOptions {
  /**
   * Only the last call of a chain of calls, so `db.query(User).first()`
   * is read once, at `.first()`.
   */
  outermost?: boolean;
}

/** A pack that recognizes calls against a store. */
export function storageCalls(
  spec: StorageCallsSpec,
  options: StorageCallsOptions = {},
): StorageCalls {
  const ending: StorageEnding = {
    yields: "storageAccess",
    system: spec.system,
    ...(spec.transport === undefined ? {} : { transport: spec.transport }),
    scope: spec.scope ?? "default",
    unsettledName: spec.unsettledName ?? "reference",
  };
  const outermost: Link<StorageMethod>[] =
    options.outermost === true ? [{ asks: "outermost" }] : [];
  return chainFrom({
    links: [
      ...chainStart<StorageMethod>(spec.client, spec.clientAt),
      ...outermost,
    ],
    ending,
    example: null,
  });
}

/** The container link a `container` call adds, by which form it was given. */
function containerLink(
  says: ContainerSays,
  qualified: boolean,
): Link<StorageMethod> {
  if (typeof says === "function") {
    return { asks: "container", from: says };
  }
  if (isPickList(says)) {
    return {
      asks: "container",
      argument: says,
      ...(qualified ? { qualified: true } : {}),
    };
  }
  if ("class" in says) {
    return { asks: "container", class: says.class, notFrom: says.notFrom };
  }
  if (!("at" in says) && !("from" in says)) {
    return memberContainerLink(says);
  }
  return {
    asks: "container",
    argument: says,
    ...(qualified ? { qualified: true } : {}),
  };
}

/** The container link for the member the steps reach, which a SQL chain states too. */
export function memberContainerLink(says: MemberContainer): ContainerMember {
  return {
    asks: "container",
    of: says.of,
    ...(says.naming === undefined ? {} : { naming: says.naming }),
  };
}

// `Array.isArray` does not narrow a readonly array out of a union.
function isPickList(says: ContainerSays): says is readonly ArgumentPick[] {
  return Array.isArray(says);
}

/** The subject link an `about` call adds, with the options after its steps when it states some. */
function subjectLink(
  of: readonly CallStep[] | readonly [...CallStep[], AboutOptions],
): SubjectLink {
  const last = of[of.length - 1];
  if (last === undefined || "to" in last) {
    return { asks: "subject", of: of as readonly CallStep[] };
  }
  return {
    asks: "subject",
    of: of.slice(0, -1) as readonly CallStep[],
    calledAs: last.calledAs,
  };
}

/** The chain with its methods table's `otherwise` set, and an empty table added when it has none. */
function withOtherwise(
  declared: Chain<StorageMethod>,
  meaning: StorageMethod,
): Chain<StorageMethod> {
  const hasTable = declared.links.some((link) => link.asks === "methods");
  const links: Link<StorageMethod>[] = hasTable
    ? declared.links.map((link) =>
        link.asks === "methods" ? { ...link, otherwise: meaning } : link,
      )
    : [
        ...declared.links,
        { asks: "methods", table: {}, ignoringCase: false, otherwise: meaning },
      ];
  return { ...declared, links };
}

/** The same chain with one more link, or with its example set. */
function chainFrom(declared: Chain<StorageMethod>): StorageCalls {
  const adding = (link: Link<StorageMethod>): StorageCalls =>
    chainFrom({ ...declared, links: [...declared.links, link] });

  return {
    declared,
    about: (...of) => adding(subjectLink(of)),
    methods: (table, options) =>
      adding({
        asks: "methods",
        table,
        ignoringCase: options?.ignoringCase ?? false,
        ...(options?.of === undefined ? {} : { of: options.of }),
      }),
    otherwise: (meaning) => chainFrom(withOtherwise(declared, meaning)),
    calls: (meaning) => adding({ asks: "calls", meaning }),
    container: (says, options) =>
      adding(containerLink(says, options?.qualified === true)),
    relations: (says) =>
      adding({ asks: "relations", of: says.of, by: says.by }),
    accessPath: (says) => adding({ asks: "accessPath", argument: says }),
    scope: (says) => adding({ asks: "scope", argument: says }),
    containersIn: (says, options) =>
      adding({
        asks: "containers",
        in: says,
        each: options?.each ?? "entry",
      }),
    input: (says) => adding({ asks: "input", at: says }),
    slots: (says) => adding({ asks: "slots", says }),
    example: (code) => chainFrom({ ...declared, example: code }),
  };
}
