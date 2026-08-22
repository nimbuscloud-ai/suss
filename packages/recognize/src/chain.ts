/**
 * The spine every pack shares, as a chain of links.
 *
 * A pack does four jobs, and all four start the same way: match the
 * receiver, match the method, read the arguments, then yield. What
 * differs is the ending. Recognition yields effects, discovery yields a
 * unit, a terminal yields a response write, and a claimed callback
 * yields a sub-unit. Only the effects ending is built; the others are
 * further members of `Ending` with an entry in the compile table.
 *
 * A link's answer is data wherever it can be. A link given a function
 * instead is code, that link alone, and pack health says which ones.
 */

import type { CallOps, ReceiverOrigin } from "./ops.js";

/** A link whose answer a pack wrote as code rather than as data. */
export interface LinkFunction<A extends unknown[], R> {
  (...args: A): R;
  /** Set when the function was built through `@suss/recognize/ast`. */
  readonly reachesAst?: boolean;
}

/**
 * What a match starts from.
 *
 * Most of what the shipped packs match starts from a receiver, and none
 * of what discovery matches does: an exported name, a file path, a
 * decorator, a parameter's type, a template file beside the module and
 * a function's return type each start somewhere else. So the start is
 * its own axis, and a receiver origin is one value on it.
 */
export type MatchStart = FromReceiver;

/** A match that starts from the receiver a call is on. */
export interface FromReceiver {
  readonly starts: "receiver";
  readonly origin: ReceiverOrigin;
}

/** Where the match begins. */
export interface StartLink {
  readonly asks: "start";
  readonly at: MatchStart;
}

/** Which methods count, and what each one does. */
export interface MethodsLink<TMeaning> {
  readonly asks: "methods";
  readonly table: Readonly<Record<string, TMeaning>>;
  /**
   * Whether two spellings of one method name are the same method. One
   * client library lower-cases where another camel-cases, and both are
   * sending the same command.
   */
  readonly ignoringCase: boolean;
}

/**
 * Which container a call's selector belongs to.
 *
 * The call in hand comes second so that a rule written over the
 * selector alone, which is most of them, ignores it. A rule that has to
 * read the syntax tree goes through `astLink`, which is what puts the
 * call to use.
 */
export interface ContainerLink {
  readonly asks: "container";
  readonly from: LinkFunction<[readonly string[], CallOps], string | null>;
}

/** One question in a chain, and the answer the pack gave for it. */
export type Link<TMeaning> = StartLink | MethodsLink<TMeaning> | ContainerLink;

/** Which argument or arguments say what a call reached. */
export type ArgumentPick = { readonly at: number } | { readonly from: number };

/** What one method of a storage client does. */
export interface StorageMethod {
  readonly kind: "read" | "write";
  /** Which argument or arguments say what the call reached. */
  readonly selector?: ArgumentPick;
  /** Which argument says which field inside it, when the method takes one. */
  readonly fields?: ArgumentPick;
}

/** What a chain produces when every link matches. */
export type Ending = StorageEnding;

/** A storage access: one call, one thing it read or wrote. */
export interface StorageEnding {
  readonly yields: "storageAccess";
  /** The store, in the words OpenTelemetry's semantic conventions use. */
  readonly system: string;
  /** The wire, when it differs from the store's own name. */
  readonly transport?: string;
  /** Which of the store's namespaces the call reached. */
  readonly scope: string;
  /** What a reader gives back for a name nothing in the source settles. */
  readonly unsettledName: "nothing" | "reference";
}

/**
 * A pack's declaration for one kind of call: the links, the ending, and
 * a line of code it matches.
 */
export interface Chain<TMeaning = StorageMethod> {
  readonly links: readonly Link<TMeaning>[];
  readonly ending: Ending;
  /** A line of code this matches, which the pack's tests run. */
  readonly example: string | null;
}
