/**
 * The vocabulary a language adapter implements so that any declared pack
 * runs on it. A pack is data, so the adapter has to turn "did this module
 * declare the method" into a yes or no about a particular program, and
 * these interfaces are everything a pack can ask of it.
 *
 * They are in this package rather than beside the builders in
 * `@suss/recognize`, so an adapter imports the types without that
 * package's runtime code. Only the TypeScript adapter implements them.
 *
 * Nothing here mentions a syntax tree. A pack that needs the tree goes
 * through `@suss/recognize/ast`, a separate import so that reaching for
 * it shows up in a diff and in the pack health report.
 */

/**
 * How a pack pins down the receiver a call is on. The recognize package's
 * DESIGN.md lists the origins not built yet (#542) and the places a match
 * can start that are not receivers.
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

import type { EffectArg } from "./index.js";

/**
 * What a reader returns for a name nothing in the source settles.
 * `"nothing"` returns null, and `"reference"` returns the name of the
 * value to look up instead.
 */
export type UnsettledName = "nothing" | "reference";

/**
 * One value a call states, as the questions a pack can ask about it.
 *
 * `CallOps` reaches the calls around the one in hand, and this reaches the
 * values that are not calls. A library that takes one request object puts
 * everything the call does inside it, as a list or as a string in the
 * library's own query language. A pack that reads those gets this instead
 * of the adapter's node, so its rule runs on any adapter with the ops.
 */
export interface ValueOps {
  /** The text of the string the source wrote, or null for anything else. */
  text(): string | null;
  /**
   * The name of this value, when the source refers to it by name instead
   * of writing it out. A queue URL is nearly always
   * `process.env.ORDERS_QUEUE_URL`, so the value only exists at deploy
   * time and both sides of the boundary use the env var's name.
   * `"reference"` returns that name, and `"nothing"` returns null for
   * anything the source does not settle.
   */
  name(unsettled: UnsettledName): string | null;
  /**
   * Every string this value can be, when the source limits it to a
   * few. `` `record.${op}` `` with `op` typed `"a" | "b"` is
   * `record.a` and `record.b`. Null when part of it could be anything,
   * or when there are more than `cap`. An adapter that has not
   * implemented this leaves it out, and a reader has only `name`.
   */
  names?(cap: number): readonly string[] | null;
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
   * This value in the form an effect records an argument, or null when
   * the adapter cannot write one. A pack that wants a payload compared
   * across a boundary asks for this, since a body reduced to text
   * cannot be paired field by field.
   */
  asArg(): EffectArg | null;
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
   * What a hole means is up to the pack. This only reports what was
   * written there, so a query that interpolates a table object can still
   * be read.
   */
  holes(): readonly (CallOps | null)[];
  /**
   * The same holes as values, in the same order, for a reader that
   * wants what the source settled a hole to rather than what call was
   * written there. A table name kept in a module constant needs this:
   * the hole is a name, so `holes` gives null for it and this gives the
   * constant.
   *
   * An adapter that has not implemented this leaves it out, and a
   * reader then has only the calls.
   */
  interpolated?(): readonly ValueOps[];
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
 * are both these same questions asked one step along, so neither needs
 * a question of its own.
 */
export interface CallOps {
  /** Which method the call reaches for, spelled as the source spells it. */
  method(): string | null;
  /** Whether the receiver came from where the origin says. */
  receiverIsFrom(origin: ReceiverOrigin): boolean;
  /**
   * Whether the callee itself came from where the origin says. A pack
   * that steps to an argument such as `new GetCommand(...)` asks this
   * first, so it never reads a command from some other library.
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
   * Whether the call goes to a name the program bound, rather than to
   * an expression written in place. `useAppStore(...)` does;
   * `create()(...)` does not, even though both are bare calls.
   */
  namedCallee?(): boolean;
  /**
   * The properties the function argument in this position reads off
   * its first parameter, one per distinct first segment: `(s) =>
   * s.bears.count` reads `bears`, and a parameter used whole reads
   * `*`. Null when the argument is not a function of one plain
   * parameter.
   */
  parameterReadsAt?(index: number): readonly string[] | null;
  /**
   * One property of the object literal passed at this position. A
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
  /**
   * The one call behind the receiver the origin accepts, however many
   * name, construction, or query hops separate them, such as Mongoose's
   * `model(...)` behind a document. Null when nothing
   * behind the receiver matches, when two distinct calls do (picking
   * one would depend on the order facts arrived), and for an origin
   * kind with no construction to hand back.
   */
  anchorCall?(origin: ReceiverOrigin): CallOps | null;
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
