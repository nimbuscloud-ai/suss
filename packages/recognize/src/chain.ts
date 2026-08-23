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

/**
 * One step from a call to another call it reaches.
 *
 * A pack that has to read a chain of calls, or a command a call was
 * handed, states the steps to it and asks the same questions there. The
 * steps are data, so a pack that reads three calls still declares three
 * links rather than one function that walks.
 */
export type CallStep = ToReceiver | ToArgument;

/**
 * The call the receiver is. With a method, the walk keeps going up the
 * receivers until it reaches a call to that method, which is how a pack
 * says which hop it means where the shape varies:
 * `bucket(b).file(p).download()` and `bucket(b).getFiles()` put the
 * bucket a different distance away.
 */
export interface ToReceiver {
  readonly to: "receiver";
  readonly method?: string;
}

/** The call an argument is, when the argument is a call or a construction. */
export interface ToArgument {
  readonly to: "argument";
  /** Which argument, or every argument from a position on. */
  readonly at: number | { readonly from: number };
}

/**
 * Which call a chain is about, when it is not the one in hand.
 *
 * The method is `send` at every AWS SDK call site in a codebase, and
 * what the call does is inside the command it was handed. A chain about
 * the command reads the operation, the container and the selector off
 * it, and the effect still records the call in hand as its callee.
 */
export interface SubjectLink {
  readonly asks: "subject";
  readonly of: readonly CallStep[];
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
 * Which container a call's selector belongs to, as an argument the call
 * states or as the pack's own rule over what the call reached.
 */
export type ContainerLink = ContainerArgument | ContainerRule;

/** The container as one of the call's own arguments states it. */
export interface ContainerArgument {
  readonly asks: "container";
  readonly argument: ArgumentPick;
}

/**
 * The container worked out by the pack. The call the chain is about
 * comes second so that a rule written over the selector alone, which is
 * most of them, ignores it. A rule that has to read the syntax tree
 * goes through `astLink`, which is what puts the call to use.
 */
export interface ContainerRule {
  readonly asks: "container";
  readonly from: LinkFunction<[readonly string[], CallOps], string | null>;
}

/** One question in a chain, and the answer the pack gave for it. */
export type Link<TMeaning> =
  | StartLink
  | SubjectLink
  | MethodsLink<TMeaning>
  | ContainerLink;

/**
 * Which argument or arguments say what a call reached, and where to go
 * looking. Without `of` the argument belongs to the chain's subject.
 */
export type ArgumentPick = OneArgument | ArgumentsFrom;

/** The argument in one position. */
export interface OneArgument {
  /** The steps to the call the argument belongs to. */
  readonly of?: readonly CallStep[];
  readonly at: number;
  /**
   * Properties of the object the argument states, tried in order, when
   * what the call reached is inside the argument rather than being it.
   */
  readonly property?: readonly string[];
}

/** Every argument the call passes from one position on. */
export interface ArgumentsFrom {
  /** The steps to the call the arguments belong to. */
  readonly of?: readonly CallStep[];
  readonly from: number;
  /** Properties of the object each argument states, tried in order. */
  readonly property?: readonly string[];
}

/**
 * What one method of a storage client does to the store: a read, a
 * write, or whichever of the two one of its arguments asked for.
 */
export type AccessKind = "read" | "write" | KindAsAsked;

/** A method the caller tells which way round it goes. */
export interface KindAsAsked {
  /** Where the call says what it is for. */
  readonly asks: ArgumentPick;
  /** What each thing the caller can ask for comes to. */
  readonly means: Readonly<Record<string, "read" | "write">>;
  /** What it comes to when the call says nothing. */
  readonly otherwise: "read" | "write";
}

/** What one method of a storage client does. */
export interface StorageMethod {
  readonly kind: AccessKind;
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
