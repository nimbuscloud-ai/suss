/**
 * The vocabulary a language adapter implements so that any declared pack
 * runs on it. A pack is data, so the adapter has to turn "did this module
 * declare the method" into a yes or no about a particular program, and
 * these interfaces are everything a pack can ask of it.
 *
 * They are in this package rather than beside the builders in
 * `@suss/recognize`, so an adapter imports the types without that
 * package's runtime code. The TypeScript adapter implements them over
 * its syntax tree, and every adapter through the ops over the facts in
 * `@suss/recognize/ops`.
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
export type ReceiverOrigin =
  | DeclaredBy
  | ConstructedFrom
  | AnyOf
  | ReturnedBy
  | Typed
  | Imported
  | Global;

/**
 * A receiver, or the callee of a call with no receiver, spelled as one of
 * these paths: `console`, `process.stdout`, `sys.stdout`, `$stdout`,
 * `print`. The runtime provides it and nothing declares it, so how the
 * source spells it is all there is to match. Each adapter says what
 * spelled means in its language.
 */
export interface Global {
  readonly origin: "global";
  readonly paths: readonly string[];
}

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

/** A receiver any one of these origins accepts. */
export interface AnyOf {
  readonly origin: "anyOf";
  readonly of: readonly ReceiverOrigin[];
}

/**
 * A receiver a library method returned, when it was called on a receiver
 * from `on`. The program never says what a library method gives back, so
 * the pack does: an Airflow hook's `get_client()` returns the BigQuery
 * client.
 */
export interface ReturnedBy {
  readonly origin: "returnedBy";
  readonly method: string;
  readonly on: ReceiverOrigin;
}

/**
 * A receiver the program declares as one of a module's types, such as a
 * parameter annotated `CommandDispatcher`. A project hands its own
 * dispatcher around this way, so where the value was made is often
 * nowhere in sight. In a language that declares no types, the receiver
 * is one made from one of those types.
 */
export interface Typed {
  readonly origin: "typed";
  /** The modules the type comes from. */
  readonly importedFrom: readonly string[];
  /** The type names, as those modules export them. */
  readonly named: readonly string[];
}

/**
 * A value the file brought in from one of these modules: a function it
 * calls bare, a namespace it calls a method on, or a class it calls a
 * static method on.
 */
export interface Imported {
  readonly origin: "imported";
  readonly importedFrom: readonly string[];
  /**
   * The names it was imported under, as the module exports them. `*` is
   * the module itself, as `import * as ledger` brings it in. Unset takes
   * any name.
   */
  readonly named?: readonly string[];
}

/** One function per kind of origin, each handed that kind and `A`. */
export type ByOrigin<T, A extends readonly unknown[] = []> = {
  readonly [K in ReceiverOrigin["origin"]]: (
    origin: Extract<ReceiverOrigin, { origin: K }>,
    ...rest: A
  ) => T;
};

/** The entry of a `ByOrigin` table for this origin, applied to it. */
export function byOrigin<T, A extends readonly unknown[] = []>(
  table: ByOrigin<T, A>,
  origin: ReceiverOrigin,
  ...rest: A
): T {
  const read = table[origin.origin] as (
    origin: ReceiverOrigin,
    ...rest: A
  ) => T;
  return read(origin, ...rest);
}

import type { Effect, TypeShape } from "@suss/behavioral-ir";
import type { DiscoveredSubUnitParent } from "./framework.js";
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
  /**
   * The one string, number or boolean this value comes to, with the
   * names and templates in it folded. Null when it comes to anything
   * else, or to more than one. `text` and `flag` read only what the
   * source wrote here, so a reader that wants a constant kept in another
   * file asks this.
   */
  evaluated?(): string | number | boolean | null;
  /**
   * The object this value comes to, through names and through a call
   * that returns its argument, or null for anything else. A call into a
   * factory comes to nothing here.
   */
  object?(): ValueOps | null;
  /**
   * The function this value is: one written here, one a name comes to,
   * or the one a call into a factory gives back. Null for anything else.
   */
  function?(): ValueOps | null;
  /** The value as the source wrote it, before any name in it is followed. */
  source?(): string;
  /**
   * How the source wrote this value at this spot, without following
   * anything: a function written in place, a name, an object written
   * out, or anything else. A word the language keeps for no value, such
   * as `undefined`, is other.
   */
  form?(): ValueForm;
  /**
   * What the object written out here states under one of its own keys,
   * or null. A spread is not read. A name for an object gives null, since
   * only an object written at this spot is read.
   */
  ownProperty?(name: string): ValueOps | null;
  /**
   * The module this value was imported from, spelled as the import
   * statement spells it, when the value is a name the file imports.
   * Null for anything else.
   */
  importedFrom?(): string | null;
  /**
   * The value this one is an encoding of, and the encoding:
   * `JSON.stringify(x)` is `x` under `json`. Null when the source does
   * not write this value as a call of one of the language's encoders.
   * A producer serializes a message before it sends it, and a consumer
   * reads the fields back after decoding, so the value worth comparing
   * across a boundary is the one that went in.
   */
  encoded?(): Encoded | null;
  /**
   * The shape the source writes this value in at this spot, without
   * following a name: a record for an object written out, a reference
   * for a name. Null when the adapter cannot say.
   */
  shape?(): TypeShape | null;
}

/**
 * A library base a class's ancestry reaches: one of `named`, as one of
 * the modules in `from` exports it. Ruby has no imports, so `from` lists
 * the library's own constant: `ViewComponent` for `ViewComponent::Preview`.
 */
export interface Inherits {
  readonly from: readonly string[];
  readonly named: readonly string[];
}

/** What an encoder was handed, and how it encoded it. */
export interface Encoded {
  /** The encoding, such as `json`. */
  readonly codec: string;
  /** The value that went in. */
  readonly value: ValueOps;
}

/** How the source wrote a value where it is read. */
export type ValueForm = "function" | "name" | "object" | "other";

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
 * An object's entries as they are once the object is built. A key
 * written twice, directly or through a spread, keeps the place it was
 * first written at and takes the value written last, which is what
 * JavaScript, Python and Ruby all do. An entry whose key nothing settles
 * stays where it is, since it cannot be matched against another.
 */
export function lastValueWins<T extends { readonly key: string | null }>(
  entries: readonly T[],
): T[] {
  const kept: T[] = [];
  const placeOf = new Map<string, number>();
  for (const entry of entries) {
    const place = entry.key === null ? undefined : placeOf.get(entry.key);
    if (place !== undefined) {
      kept[place] = entry;
      continue;
    }
    if (entry.key !== null) {
      placeOf.set(entry.key, kept.length);
    }
    kept.push(entry);
  }
  return kept;
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
   * The one path among `paths` the receiver is: spelled as it, or a value
   * the rules followed that global into, such as a parameter a caller
   * passed `process.stdout` to. Null when two of them reach it, and
   * undefined when none does.
   */
  receiverGlobal?(paths: readonly string[]): string | null | undefined;
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
   * Said by a chain that steps to the arguments of every call it sees,
   * before it reads the first one: at every call the walk visits, it
   * will read the arguments from `first` through `last`, or to the end
   * when `last` is left out. An adapter that asks a separate question
   * for each read can ask about all of them at once. Leaving it out
   * changes how fast a run is and nothing else.
   */
  readingArguments?(first: number, last?: number): void;
  /**
   * Said by a chain before it asks what made a receiver: at every call
   * the walk visits whose method is one of `methods`, spelled as the
   * source spells it, it will ask about the receiver. An adapter can
   * then ask about all of them at once, and leaving it out changes only
   * how fast a run is.
   */
  readingReceivers?(methods: ReadonlySet<string>): void;
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
   * The name the callee was imported under from one of these modules, as
   * the module exports it: `GetCommand` for `new Get(...)` after
   * `import { GetCommand as Get }`. Null when the callee was not imported
   * from them, or was imported under two names.
   */
  calleeImportedAs?(modules: readonly string[]): string | null;
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
   * The value the call passes under this keyword, `query=` in Python or
   * `query:` in Ruby, or null when it passes none. Unset in a language
   * whose calls take no keywords.
   */
  keywordAt?(name: string): ValueOps | null;
  /**
   * The block the call is written with, as a function, or null when it
   * has none. Unset in a language whose calls take no blocks.
   */
  block?(): ValueOps | null;
  /**
   * The one call behind the receiver the origin accepts, however many
   * name, construction, or query hops separate them, such as Mongoose's
   * `model(...)` behind a document. Null when nothing
   * behind the receiver matches, when two distinct calls do (picking
   * one would depend on the order facts arrived), and for an origin
   * kind with no construction to hand back.
   */
  anchorCall?(origin: ReceiverOrigin): CallOps | null;
  /**
   * The class the argument in this position refers to, or null when it
   * refers to none the run declares. An ORM that takes an entity class,
   * `InjectRepository(Order)`, keeps the table on the class itself.
   */
  classAt?(index: number): ClassOps | null;
  /**
   * Said by a recognizer about an effect it built from this call: the
   * value the call states for each column the effect writes or picks
   * rows by. The adapter asks where each value came from and records it
   * on the transition. Leaving it out changes only that record.
   */
  statesSlots?(effect: Effect, slots: readonly StatedSlot[]): void;
}

/** A column an effect writes or picks rows by, and the value stated for it. */
export interface StatedSlot {
  readonly slot: "field" | "selector";
  readonly name: string;
  readonly value: ValueOps;
}

/** One class a call refers to, as the questions a pack can ask about it. */
export interface ClassOps {
  /** The name the class is declared under, or null when it has none. */
  name(): string | null;
  /**
   * The one decorator call on the class that the origin accepts, such
   * as `@Entity("orders")`. Null when none does, or when two do.
   */
  decorator(origin: ReceiverOrigin): CallOps | null;
}

/** The rows of a fact database, as the ops over the facts read them. */
export interface FactRows {
  /** The rows of `relation` whose column `column` is `value`. */
  lookup(
    relation: string,
    column: number,
    value: string,
  ): readonly (readonly unknown[])[];
}

/**
 * What an adapter hands the ops in `@suss/recognize/ops`: its facts, and
 * the reads only it can make. The recognize package's DESIGN.md has the
 * fact behind each op.
 */
export interface FactSource {
  readonly db: FactRows;
  /** Make sure the facts about this key are in `db`. An adapter that states every fact up front does nothing. */
  read(key: string): void;
  /** The key a name or field was written as, by the adapter's own rules, or null. */
  writtenAs(key: string): string | null;
  /**
   * Every call the anchor rules reach behind a value. An adapter may leave
   * out the calls its own check of the origin turns down; the ops check
   * each one that comes back against the origin as well.
   */
  anchorCalls(key: string, origin: ReceiverOrigin): readonly string[];
  /** Whether the value at this key was imported from the module. */
  importedFrom(key: string, module: string): boolean;
  /**
   * The names the value at this key was imported under from the module,
   * as the module exports them: `*` for the module itself. Empty when it
   * came from somewhere else.
   */
  importedAs(key: string, module: string): readonly string[];
  /** Whether a written-out value is an object, a list, or neither. */
  shapeOf(key: string): "object" | "list" | null;
  /**
   * The method a stated member read spells, for an adapter that states a
   * class's own method under a spelling of its own. Null leaves the read
   * out. Unset takes every name as it is stated.
   */
  memberName?(stated: string): string | null;
  /**
   * The class a callee makes one of, for a language that makes one by
   * calling a method on the class: `Connection` for the `new` in
   * `PG::Connection.new`. Null for any other callee, and unset where
   * calling the class itself makes one.
   */
  constructedClass?(callee: string): string | null;
  /** The source text at the key. */
  textOf(key: string): string;
  /** How the source wrote the value at the key, as `ValueOps.form` says. Unset reads every value as other. */
  formOf?(key: string): ValueForm;
  /** The string, number or boolean written at the key, or null when it is not one. */
  literalOf(key: string): string | number | boolean | null;
  /** The name the value gives, read the adapter's way. A key the source computes, `{ [table]: ... }`, is read through this too. */
  nameOf(key: string, unsettled: UnsettledName): string | null;
  /** Every string the value can be, when the adapter limits it to a few. */
  namesOf?(key: string, cap: number): readonly string[] | null;
  /** The value as an effect argument. */
  argOf(key: string): EffectArg | null;
  /**
   * The key of the value the call at `key` encodes, and the encoding,
   * when the call is one of the language's encoders. Each adapter keeps
   * its encoders in one table beside its other language words.
   */
  encodedOf?(key: string): { codec: string; value: string } | null;
  /** The shape the value at the key is written in there, as `ValueOps.shape` says. */
  typeShapeOf?(key: string): TypeShape | null;
  /** Whether the value at the key is spelled as this global path, the language's way. */
  spellsGlobal?(key: string, path: string): boolean;
  /**
   * Whether the call at the key goes to this global with no receiver, as
   * `print(x)` or `puts x` does. Python keys a bare name by its scope,
   * so the call is what can say whether the name is the builtin.
   */
  callsGlobal?(call: string, path: string): boolean;
  /**
   * The global paths whose value the rules followed into the value at the
   * key, through names and the parameters callers passed it to. Only the
   * output streams are followed so far.
   */
  globalsReaching?(key: string): readonly string[];
  /** The one string, number or boolean the evaluator settles the value at the key to, or null. */
  evaluatedOf?(key: string): string | number | boolean | null;
  /**
   * Every function and object the value at the key comes to, through
   * names and through a call that returns its argument. The ops pick the
   * one they want from these, so an adapter keeps every answer.
   */
  comesTo?(key: string): readonly string[];
  /**
   * The one function the value at the key gives back when it is a call
   * into a factory, or a name written as one.
   */
  givesBack?(key: string): string | null;
  /** The module specifier as written, when the value at the key is a name the file imports. */
  importSpecifierOf?(key: string): string | null;
  /** Whether the call goes to a method the project wrote, which no library made. */
  callsProjectMethod?(call: string): boolean;
  /** What a call into one of the project's own functions returns, as written. */
  returnedBy?(call: string): string | null;
  /** Whether a library declared the method the call reaches for, when the adapter can tell. */
  declares?(call: string, module: string): boolean;
  /**
   * Whether the call's receiver is declared as one of the origin's types.
   * Unset in a language that declares none, where the ops check what made
   * the receiver instead.
   */
  typedAs?(call: string, origin: Typed): boolean;
  /**
   * The ops for a call with the adapter's own members added, such as the
   * class an argument refers to. Every call the fact ops reach goes
   * through this, a receiver or an argument as much as the call in hand.
   */
  extend?(call: string, ops: CallOps): CallOps;
  /**
   * The ops for a value with the adapter's own members added, after it
   * has noted which of its own nodes they read, so a slot a pack states
   * can be traced back.
   */
  extendValue?(value: string, ops: ValueOps): ValueOps;
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
 * What an adapter puts in the context a `subUnits` hook gets, so a
 * declared pack can claim a callback without walking the parent's tree.
 */
export interface SubUnitOpsCarrier {
  /**
   * The calls the parent's body runs, the ones written in functions it
   * runs inline included, in the order the source writes them. A call
   * inside a function some pack claims is still listed, so a callback
   * written inside another one belongs to the same parent.
   */
  calls?(parent: DiscoveredSubUnitParent): readonly CallOps[];
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

/**
 * The value ops an adapter implements when it can hand out the node a
 * value was read at, for a reader the value ops cannot serve yet. Kept
 * off `ValueOps` for the same reason `AstCapableOps` is kept off
 * `CallOps`.
 */
export interface AstCapableValueOps extends ValueOps {
  /** The adapter's own node for the value in hand. */
  ast(): unknown;
}
