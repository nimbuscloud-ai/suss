/**
 * The vocabulary a language adapter implements so that any declared
 * pack runs on it.
 *
 * A pack is data, so something has to turn "did this module declare the
 * method" into a yes or no about a particular program. That is the
 * adapter's job, and these interfaces are the whole of what a pack can
 * ask for. An adapter implements them once and every pack runs there,
 * which is what lets one pack drive several languages.
 *
 * They live here rather than beside the builders that produce them,
 * because an adapter needs this and none of the rest: the TypeScript
 * adapter imports these types and no runtime code from
 * `@suss/recognize`. Python and Ruby will want the same.
 *
 * Nothing here mentions a syntax tree. A pack that needs the tree goes
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
  /**
   * Which of those exports, when a pack has to tell two apart. Every
   * AWS SDK command comes from the one module and goes through the one
   * `send`, so the command class is what says which operation a call
   * performs. Unset matches whatever the module exports.
   */
  readonly named?: readonly string[];
}

/**
 * What a reader gives back for a name nothing in the source settles.
 * `"nothing"` gives null, `"reference"` gives the value to go and ask
 * about instead.
 */
export type UnsettledName = "nothing" | "reference";

/**
 * One value a call states, as the questions a pack can ask about it.
 *
 * `CallOps` reaches a call beside the one in hand, and this reaches the
 * values that are not calls. A library that takes one request object
 * puts everything the call is doing inside it, sometimes as a list and
 * sometimes as a string in a little language of the library's own, and
 * a pack that reads those is handed this rather than the adapter's own
 * node. So the rule it writes runs wherever the ops do.
 */
export interface ValueOps {
  /** The text of the string the source wrote, or null for anything else. */
  text(): string | null;
  /**
   * The yes or no the source wrote here, or null for anything else. A
   * library that asks which fields a call wants states them as a map of
   * flags, `{ name: 1, password: 0 }`, and a number and a boolean mean
   * the same thing in one of those.
   */
  flag(): boolean | null;
  /** What this object states, entry by entry. Empty for anything else. */
  entries(unsettled: UnsettledName): readonly ValueEntry[];
  /** What this list states, item by item. Empty for anything else. */
  items(): readonly ValueOps[];
  /** What one named property of this object states, or null for none. */
  property(name: string): ValueOps | null;
  /**
   * The pieces of text the source wrote here, in order, with whatever
   * it interpolated between them left out. A string is one piece and a
   * template is one piece per hole plus one, so a reader that means to
   * put its own placeholders in the holes can. Null when the source
   * wrote neither.
   */
  parts(): readonly string[] | null;
  /**
   * What the source interpolated between those pieces, in order, each
   * as the call it was written as. There is one per gap, one fewer than
   * `parts` gives, and a hole the source wrote as something other than
   * a call is null rather than being dropped, so the two lists stay in
   * step.
   *
   * What a hole comes to is the pack's to say. This says what was
   * there, so a query that hands over a table object can still be read.
   */
  holes(): readonly (CallOps | null)[];
}

/** One entry of an object a call states. */
export interface ValueEntry {
  /**
   * What the entry is called. A key the source computes,
   * `{ [table]: ... }`, is read the way any other name is.
   */
  readonly key: string | null;
  /** What the entry says. */
  readonly value: ValueOps;
}

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
  /**
   * Whether the call itself came from where the origin says, which is
   * the same question asked of the callee rather than of what it was
   * called on. `new GetCommand(...)` is the case: a pack that steps to
   * an argument asks this of it before reading anything, so it never
   * reads an argument that was never the one.
   */
  isFrom(origin: ReceiverOrigin): boolean;
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
   * The call the callee itself was written as, or null when nothing
   * wrote it as one. A class a factory made is the case: `new
   * User({...})` says nothing about what `User` is, and the
   * `model("User", schema)` call it was declared as says everything.
   */
  callee(): CallOps | null;
  /**
   * What a named property of the object an argument states says. A
   * property bag is not a call, so nothing else here reaches into one.
   */
  propertyAt(
    index: number,
    property: string,
    unsettled: UnsettledName,
  ): string | null;
  /**
   * The value the argument in this position states, or null when the
   * call passes none. `propertyAt` reads one name out of a property
   * bag, which covers a pack that wants one; this hands the bag over
   * for a pack whose rule has to walk it.
   */
  valueAt(index: number): ValueOps | null;
}

/**
 * The property an adapter puts its ops on, in the context it hands a
 * recognizer. A context without it belongs to an adapter that has not
 * implemented the ops, and a declared pack matches nothing there.
 */
export interface OpsCarrier {
  ops?: CallOps;
}

/**
 * The ops an adapter implements when it can hand out its own nodes. The
 * extra member is here rather than on `CallOps` so that a pack reaching
 * for a node has to import this module first.
 */
export interface AstCapableOps extends CallOps {
  /** The adapter's own node for the call in hand. */
  ast(): unknown;
}
