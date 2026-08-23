/**
 * The operations a chain performs at one call site, and what a language
 * adapter has to be able to work out for it.
 *
 * A chain is data, so something has to turn "did this module declare
 * the method" into a yes or no about a particular program. That is the
 * adapter's job, and this interface is the whole of what a chain asks
 * for. An adapter implements it once and every declared pack runs
 * there, which is what lets one pack drive several languages.
 *
 * Nothing here mentions a syntax tree. A link that needs the tree goes
 * through `@suss/recognize/ast`, a separate import so that reaching for
 * it shows up in a diff and in the pack health report.
 */

/**
 * How a pack pins down the receiver a call is on.
 *
 * The migration plan for #542 lists four more: `factoryMade` (`app =
 * express()`), `imported`, `anchored` (a chain read from its anchor
 * call), `inherits` (a Ruby or Python receiver matched by ancestry) and
 * `global` (`process.env`, bare `fetch`). Each arrives as a member here
 * with an entry in every adapter's dispatch table. The README beside
 * this file says which starts are not receiver-shaped at all.
 */
export type ReceiverOrigin = DeclaredBy | ConstructedFrom;

/**
 * A receiver whose method one of these modules declared.
 *
 * This is the origin for a client the source never spells out. `const
 * redis = await this.getClient()` says nothing about ioredis, and the
 * declaration behind `redis.get` says everything.
 */
export interface DeclaredBy {
  readonly origin: "declaredBy";
  /** The modules whose declarations settle the call. */
  readonly importedFrom: readonly string[];
}

/**
 * A client made from a module's export, however the program caches it.
 * Asked of the receiver itself, so it still works where the method is untyped
 * and `declaredBy` finds nothing to read. A call that reaches for no
 * receiver, `new GetObjectCommand(...)`, is made by its own callee.
 */
export interface ConstructedFrom {
  readonly origin: "constructed";
  /** The modules whose export the client was made from. */
  readonly importedFrom: readonly string[];
}

/**
 * A receiver whose method one of these modules declared. Pass every
 * module that ships the same client, the way three packages all speak
 * one wire protocol.
 */
export function declaredBy(...importedFrom: readonly string[]): DeclaredBy {
  return { origin: "declaredBy", importedFrom };
}

/** A client made from one of these modules' exports. */
export function constructedFrom(
  ...importedFrom: readonly string[]
): ConstructedFrom {
  return { origin: "constructed", importedFrom };
}

/**
 * What a reader gives back for a name nothing in the source settles.
 * `"nothing"` gives null, `"reference"` gives the value to go and ask
 * about instead.
 */
export type UnsettledName = "nothing" | "reference";

/**
 * One call site, as the questions a chain asks about it.
 *
 * An adapter builds one of these per call and hands it to the
 * recognizer through its context. Every member is about the call in
 * hand, so there is no node to pass around and no place for a pack to
 * reach past what it declared.
 *
 * Two members give back another `CallOps`, which is how these questions
 * reach a call next to this one. A chain of calls and a command object
 * are both these same questions asked one step along, so neither needed
 * a question of its own.
 */
export interface CallOps {
  /** Which method the call reaches for, spelled as the source spells it. */
  method(): string | null;
  /** Whether the receiver came from where the origin says. */
  receiverIsFrom(origin: ReceiverOrigin): boolean;
  /** How many arguments the call passes. */
  argumentCount(): number;
  /** The name the argument in this position gives. */
  nameAt(index: number, unsettled: UnsettledName): string | null;
  /** The callee, as the source writes it. */
  calleeText(): string;
  /**
   * The call the receiver is, or null when the receiver is not a call.
   * A receiver the source wrote into a variable comes back as the call
   * it was written as.
   */
  receiver(): CallOps | null;
  /**
   * The call the argument in this position is, or null when that
   * argument is neither a call nor a construction. `new
   * GetObjectCommand(...)` comes back as a call whose callee is the
   * class, the same as any other call.
   */
  argument(index: number): CallOps | null;
  /**
   * What a named property of the object an argument states says. A
   * property bag is not a call, so nothing else here reaches into one.
   */
  propertyAt(
    index: number,
    property: string,
    unsettled: UnsettledName,
  ): string | null;
}

/**
 * The property an adapter puts its ops on, in the context it hands a
 * recognizer. A context without it belongs to an adapter that has not
 * implemented the ops, and a declared pack matches nothing there.
 */
export interface OpsCarrier {
  ops?: CallOps;
}

/** The ops in a recognizer context, or null when the adapter has none. */
export function opsIn(ctx: unknown): CallOps | null {
  const carrier = ctx as OpsCarrier | null | undefined;
  return carrier?.ops ?? null;
}
