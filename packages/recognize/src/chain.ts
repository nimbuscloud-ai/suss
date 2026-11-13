/**
 * The chain of links every declared pack is written as.
 *
 * A pack does four jobs, and all four start the same way: match the
 * receiver, match the method, read the arguments, then yield. Only the
 * ending differs. Recognition yields effects, discovery yields a unit,
 * a terminal yields a response write, and a claimed callback yields a
 * sub-unit. Only recognition endings exist so far: storage, SQL,
 * message send and unit invoke. Each of the other jobs would be one
 * more member of `Ending` with an entry in the compile table.
 *
 * A pack writes each link as data where it can. A link written as a
 * function is code, and the pack health report lists those links.
 */

import type {
  CodeUnitKind,
  DeployableUnit,
  MessageBusSemantics,
} from "@suss/behavioral-ir";
import type {
  CallOps,
  ReceiverOrigin,
  RuntimeObject,
  UnsettledName,
  ValueOps,
} from "./ops.js";

/** A link the pack wrote as a function instead of as data. */
export interface LinkFunction<A extends unknown[], R> {
  (...args: A): R;
  /** Set when the function was built through `@suss/recognize/ast`. */
  readonly reachesAst?: boolean;
}

/**
 * What a match starts from.
 *
 * Every recognition chain starts from a receiver. Discovery starts
 * elsewhere, for example from an exported name or a decorator. The start
 * is a union of its own so a discovery ending can add a member, and a
 * receiver is its only member today.
 */
export type MatchStart = FromReceiver;

/** A match that starts from the receiver a call is on. */
export interface FromReceiver {
  readonly starts: "receiver";
  readonly origin: ReceiverOrigin;
  /**
   * The steps from the call in hand to the one whose receiver is the
   * client, when that is not the call in hand. `db.user.findMany()` is
   * on `db.user`, and the client is `db`, one member step along.
   */
  readonly of?: readonly CallStep[];
}

/**
 * The link a chain opens with, when the pack says which client its calls
 * are on. Without a client the chain matches the method on any receiver,
 * as a global send needs.
 */
export function chainStart<TMeaning>(
  client: ReceiverOrigin | undefined,
  of?: readonly CallStep[],
): Link<TMeaning>[] {
  if (client === undefined) {
    return [];
  }
  const at: FromReceiver = {
    starts: "receiver",
    origin: client,
    ...(of === undefined ? {} : { of }),
  };
  return [{ asks: "start", at }];
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
 * steps are data, so a pack that reads three calls states three steps
 * and never writes a function that walks the calls itself.
 */
export type CallStep = ToReceiver | ToArgument | ToMember | ToChained;

/**
 * The call the receiver is. With a method, the walk keeps going up the
 * receivers until it reaches a call to that method. That lets a pack
 * pick the hop it means when the distance varies:
 * `bucket(b).file(p).download()` and `bucket(b).getFiles()` put the
 * bucket at different distances.
 */
export interface ToReceiver {
  readonly to: "receiver";
  readonly method?: string;
  /** Where the call reached has to have come from, else the step reaches nothing. */
  readonly origin?: ReceiverOrigin;
}

/** The call an argument is, when the argument is a call or a construction. */
export interface ToArgument {
  readonly to: "argument";
  /** Which argument, or every argument from a position on. */
  readonly at: number | { readonly from: number };
  /**
   * Where the argument has to have come from, for a step that tries
   * several. `send(command)` takes one argument and a presigner takes
   * two. Only the command the SDK declares matters, so the step requires
   * that origin and skips any other argument.
   */
  readonly origin?: ReceiverOrigin;
}

/**
 * The receiver as the source wrote it, when it is a member read rather
 * than a call: `db.user` in `db.user.findMany()`. The ops it gives
 * return the member's name, `user`, from `method()`, and ask an origin
 * about the object it is read off, `db`. Ruby writes a bare `db.users`
 * as a call with no arguments, and the step gives that call.
 */
export interface ToMember {
  readonly to: "member";
  /** The name the member has to be read as, else the step reaches nothing. */
  readonly named?: string;
}

/**
 * The nearest call to `method` made on what this call returns, however
 * many calls out: `.where` from `db.update(t)` in
 * `db.update(t).set(v).where(c)`. A query builder takes its table from
 * the first call and its columns from a call further out.
 */
export interface ToChained {
  readonly to: "chained";
  readonly method: string;
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
  /**
   * Which methods the call in hand may be, when only some of the calls
   * made on the subject count. Drizzle's select is read at `.from`,
   * since every select chain has one and the table is its argument.
   */
  readonly calledAs?: readonly string[];
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
 * states, as the member the call is made on, or as the pack's own rule
 * over what the call reached.
 */
export type ContainerLink = ContainerArgument | ContainerMember | ContainerRule;

/**
 * The member the steps reach, as a container. Prisma lowercases a model's
 * first letter for its delegate, so `upperFirst` reads `db.user` as `User`.
 */
export interface ContainerMember {
  readonly asks: "container";
  readonly of: readonly CallStep[];
  readonly naming?: Naming;
}

/** How a pack spells a name it read as the name the contract uses. */
export type Naming = "asWritten" | "upperFirst";

/** The container as one of the call's own arguments states it. */
export interface ContainerArgument {
  readonly asks: "container";
  /**
   * Where the call states the container. A list is tried in order until
   * one of the picks reaches a name. BigQuery's `load` is passed the
   * table on a dataset and a file on a table, so its pack lists the
   * chain's `table` call first and the call's own argument second.
   */
  readonly argument: ArgumentPick | readonly ArgumentPick[];
  /**
   * Whether the argument writes the table the way a statement does,
   * `"analytics.events"`, so the part before the table is the scope. A
   * name that does not settle leaves the call without an access.
   */
  readonly qualified?: boolean;
}

/**
 * The container worked out by the pack. The call comes second so that a
 * rule over the selector alone, as most are, can leave it out. A rule
 * that has to read the syntax tree gets the call through `astLink`.
 */
export interface ContainerRule {
  readonly asks: "container";
  readonly from: LinkFunction<[readonly string[], CallOps], string | null>;
}

/** Which way into the container the call took, when it states one. */
export interface AccessPathLink {
  readonly asks: "accessPath";
  readonly argument: ArgumentPick;
}

/**
 * Which of the store's namespaces a call reached, when the call states
 * it instead of the pack. Most clients connect to one namespace and the
 * pack states it once. A BigQuery caller writes the dataset on the way
 * to the table, and without this a project reading two datasets would
 * record both accesses under the same scope.
 */
export interface ScopeLink {
  readonly asks: "scope";
  readonly argument: ArgumentPick;
}

/**
 * Where a call states the containers it reached, for a call that
 * reaches several at once. A batch or a transaction states them as a
 * map, one entry per container, so the chain yields one effect per
 * entry: the entry's own key is what the container is called, and its
 * value says what the call did there.
 */
export interface ContainersLink {
  readonly asks: "containers";
  readonly in: OneArgument;
  /**
   * How to read each item. An entry keys the container by name and its
   * value says what the call did there, as in a batch write. A name is
   * the container on its own, as in a call that reads several parameters
   * at once. Defaults to an entry.
   */
  readonly each?: "entry" | "name";
}

/**
 * Where a call states its inputs, when it states them as one object
 * instead of as positional arguments. A call without that object does
 * not match. A rule the pack writes over the inputs receives the object
 * itself, so it never has to find the right position.
 */
export interface InputLink {
  readonly asks: "input";
  readonly at: OneArgument;
}

/**
 * Where a call states the value for each column, as paths of keys
 * under its input. Without this link the slots are what the pack's
 * rules read under each column's name, so a rule that reads
 * `select: { id: true }` gives `id` the value `true`. A pack whose
 * payload says where the values are writes that down here instead.
 */
export interface DeclaredSlots {
  /** Paths to the objects whose entries are the selector columns' values. */
  readonly selector?: readonly (readonly string[])[];
  /** Paths to the objects whose entries are the written columns' values. */
  readonly field?: readonly (readonly string[])[];
  /** Which kinds of access state field slots. Unset states them on every kind. */
  readonly fieldsOn?: readonly ("read" | "write")[];
}

export interface SlotsLink {
  readonly asks: "slots";
  /** The paths, or `"none"` for a pack whose calls state no slots. */
  readonly says: DeclaredSlots | "none";
}

/**
 * Where a call states the accesses it makes through the container's
 * relations, and the pack's rule that reads them. Each one becomes an
 * effect of its own after the container's, on the same binding, and the
 * checker places it on the model the relation path leads to.
 */
export interface RelationsLink {
  readonly asks: "relations";
  readonly of: OneArgument;
  readonly by: LinkFunction<[StatedInputs], readonly RelatedAccess[]>;
}

/** One more access a call makes through a relation of the container. */
export interface RelatedAccess {
  /** The relations followed from the container, in order. */
  readonly path: readonly string[];
  readonly kind: "read" | "write";
  readonly fields: readonly string[];
  /** The operation across the relation, when it is not the call's own. */
  readonly operation?: string;
  readonly selector?: readonly string[];
  /** The columns written are the relation's own key, which only the contract lists. */
  readonly relationKey?: true;
}

/**
 * How to read the values interpolated into a statement.
 *
 * A query that interpolates a schema object for its table leaves the
 * table name out of the SQL text, and a parameter in its place does not
 * parse. Nothing in the statement shows that the object is a table, so
 * the pack says which argument of the call that built the object gives
 * the name, and where that call must have come from.
 */
export interface InterpolatesLink {
  readonly asks: "interpolates";
  /** Which argument of the call that built the value gives the name. */
  readonly named: ArgumentPick;
  /** Where the value must come from. Without it, every hole is read. */
  readonly from?: ReceiverOrigin;
}

/**
 * What a call's callback becomes when the call writes it in place: a
 * unit of its own, with the parent's binding, so what the callback does
 * goes on its own summary and not on the parent's. The adapter runs the
 * pack's `subUnits` hook this compiles to on every unit it discovers.
 */
export interface UnitWhenInPlaceLink {
  readonly asks: "unitWhenInPlace";
  /** The kind of unit the callback becomes. */
  readonly kind: CodeUnitKind;
  /** The parts its name is built from, in order. */
  readonly name: readonly SubUnitNamePart[];
}

/**
 * One part of a claimed callback's name: the parent's name, the callee
 * as the source writes it, and a count of the claims under that callee
 * in the parent, in source order. `["parent", "callee",
 * "countPerCallee"]` names the second `useQuery` callback in `OrderList`
 * `OrderList.useQuery#1`.
 */
export type SubUnitNamePart = "parent" | "callee" | "countPerCallee";

/** One question in a chain, and the answer the pack gave for it. */
export type Link<TMeaning> =
  | StartLink
  | SubjectLink
  | MethodsLink<TMeaning>
  | CallsLink<TMeaning>
  | ContainerLink
  | AccessPathLink
  | ScopeLink
  | ContainersLink
  | InputLink
  | SlotsLink
  | RelationsLink
  | InterpolatesLink
  | UnitWhenInPlaceLink
  | OffLink
  | EntriesLink
  | GettersLink
  | WritesLink
  | ThroughHelpersLink;

/**
 * Where a read chain starts: the object its reads are off. A call chain
 * starts at a receiver instead, and a read has none.
 */
export interface OffLink {
  readonly asks: "off";
  readonly object: RuntimeObject;
}

/** What a read of each entry is. `otherwise` is any entry the table does not list. */
export interface EntriesLink {
  readonly asks: "entries";
  readonly table: Readonly<Record<string, EntryMeaning>>;
  /** Without it, an entry the table does not list is no read. */
  readonly otherwise?: EntryMeaning;
}

/** Methods that read one entry, with where the key and the fallback are. */
export interface GettersLink {
  readonly asks: "getters";
  readonly table: Readonly<Record<string, GetterMeaning>>;
}

/** Entries whose assignment is a state change, and what an assignment to any other entry is. */
export interface WritesLink {
  readonly asks: "writes";
  readonly table: Readonly<Record<string, WriteMeaning>>;
  readonly otherwise?: WriteMeaning;
}

/** A call into a project function whose parameter supplies a read's key is a read at the call. */
export interface ThroughHelpersLink {
  readonly asks: "throughHelpers";
}

/** What a read of one entry of a runtime object is. */
export type EntryMeaning = ConfigEntry | MetadataEntry | NoEntry;

/**
 * A read of configuration the deployment supplies, which pairs against
 * whatever declares it. `named` replaces the entry as the read's name.
 */
export interface ConfigEntry {
  readonly reads: "config";
  readonly named?: string;
  /** Defaults to `dotted`. */
  readonly callee?: CalleeSpelling;
  /**
   * The name a read of an entry off this entry's value gets, with `{key}`
   * for that entry: `argv[{key}]` reads `process.argv[2]` as `argv[2]`,
   * beside the read of `argv` itself. Its callee is the read as written.
   */
  readonly indexed?: string;
}

/** A read of something the runtime knows about itself, which nothing pairs against. */
export interface MetadataEntry {
  readonly reads: "metadata";
  /** Defaults to `site`. */
  readonly callee?: CalleeSpelling;
}

/** An entry whose read is not one, such as `import.meta.env`, which another chain reads off. */
export interface NoEntry {
  readonly reads: "nothing";
}

/**
 * How the effect writes its callee: the object's path and the entry
 * however the read was spelled (`process.env.X` for `process.env["X"]`
 * too), the site as written, or the object's path alone.
 */
export type CalleeSpelling = "dotted" | "site" | "object";

/** An argument by position, or under a keyword in a language that has them. */
export interface ArgumentPosition {
  readonly at: number;
  readonly keyword?: string;
}

/** Where a getter call passes its fallback: an argument, or the block a Ruby call is written with. */
export type FallbackPick = ArgumentPosition | { readonly block: true };

/** A method that reads one entry, such as Python's `os.environ.get(key, default)`. */
export interface GetterMeaning {
  readonly key: ArgumentPosition;
  /** Where the call passes its fallback, or the places it can, tried in order: `ENV.fetch("X", d)` and `ENV.fetch("X") { d }`. */
  readonly fallback?: FallbackPick | readonly FallbackPick[];
  /** The getter raises when the entry is missing and no fallback is given, so a read with none is not defaulted. */
  readonly raisesWithout?: boolean;
}

/** What an assignment to one entry does. */
export interface WriteMeaning {
  readonly changes: "state" | "nothing";
}

/** What a read chain's effects say about the deployment a config read belongs to. */
export interface Deployment {
  readonly deploymentTarget?: DeployableUnit["deploymentTarget"];
  readonly instanceName?: string;
}

/**
 * A read of an object the runtime provides. A config read pairs against
 * whatever declares the entry, a metadata read records that the unit
 * depends on the runtime, and an assignment the chain lists under
 * `writes` is a state change.
 */
export interface RuntimeReadEnding {
  readonly yields: "runtimeRead";
  /** Left off a metadata read, which belongs to no deployment. */
  readonly deployment: Deployment;
}

/**
 * The meaning of a bare call of the tracked client itself. A store hook
 * such as `useAppStore((s) => s.bears)` calls no method, so a methods
 * table has nothing to list. The call matches on how its callee was
 * written.
 */
export interface CallsLink<TMeaning> {
  readonly asks: "calls";
  readonly meaning: TMeaning;
}

/**
 * Which argument or arguments say what a call reached, and where to go
 * looking. Without `of` the argument belongs to the chain's subject.
 */
export type ArgumentPick = OneArgument | ArgumentsFrom;

/**
 * The fields a selector lambda reads off its parameter, one per
 * distinct first segment: `(s) => s.bears.count` reads `bears`. The
 * value says which argument the lambda is passed as.
 */
export interface SelectorParamPick {
  readonly selectorParam: number;
}

/** The argument in one position. */
export interface OneArgument {
  /** The steps to the call the argument belongs to. */
  readonly of?: readonly CallStep[];
  readonly at: number;
  /**
   * The keyword the argument can be passed under instead, `query=` in
   * Python or `query:` in Ruby. A call that passes it there is read
   * there, and any other call at `at`.
   */
  readonly keyword?: string;
  /**
   * Keys to read down through, each inside the last, before `property`:
   * `["query", "query"]` reads the statement in
   * `insert_job(configuration={"query": {"query": sql}})`.
   */
  readonly path?: readonly string[];
  /**
   * Properties of the object the argument states, tried in order, for
   * when the thing the call reached is a property of the argument.
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

/** A method whose argument says whether the call reads or writes. */
export interface KindAsAsked {
  /** The argument that says what the call is for. */
  readonly asks: ArgumentPick;
  /** Whether each value that argument can take reads or writes. */
  readonly means: Readonly<Record<string, "read" | "write">>;
  /**
   * The kind to use when `means` does not list what the call asked for.
   * Without it such a call does not match. A pack reading a helper whose
   * operations a project lists in its own config relies on that.
   */
  readonly otherwise?: "read" | "write";
}

/** What a pack's own rule is handed: one value, and what the call does. */
export interface StatedInputs {
  /**
   * The value the rule reads: the inputs object when the chain locates
   * it with `input`, or the value the rule was pointed at otherwise.
   * When the call passed nothing there, the rule still runs, over a
   * value that states nothing. A caller that leaves out a projection
   * still reads every field, and only the pack's rule can say so.
   */
  readonly input: ValueOps;
  /** The container's own entry, when the call reached several. */
  readonly entry: ValueOps | null;
  /** What the call does to the store. */
  readonly kind: "read" | "write";
  /**
   * The container, when a link settles it before the inputs are read.
   * Null when the selector decides it, so it is not known yet.
   */
  readonly container: string | null;
  /** The call in hand, for a rule that reads something beside the source, such as the project's schema. */
  readonly call: CallOps;
}

/**
 * A pack's own rule over the inputs a call states, for a library that
 * puts the selector or the fields somewhere no argument pick can reach.
 */
export type InputRule = LinkFunction<[StatedInputs], readonly string[]>;

/**
 * A pack's own rule, pointed at the value it reads.
 *
 * `input` says where a call that states one request object states it,
 * and every rule on that chain reads that one value. A library that
 * spreads a request over several places needs each rule pointed at its
 * own value. Mongoose picks documents by the first argument and reads
 * the fields the second asks for. Drizzle puts the fields, the table
 * and the condition on three calls of one chain, which the pick's own
 * `of` steps reach.
 */
export interface StatedRule {
  /** Which value the rule reads. */
  readonly of: OneArgument;
  /** What the pack works out from it. */
  readonly by: InputRule;
}

/**
 * The columns a condition compares: every property the picked value
 * reads off the argument `off` points at, through the calls,
 * comparisons and template holes the condition is built from.
 * `eq(users.id, id)` reads `id` off `users`, and so does
 * `User.id == user_id`.
 */
export interface FieldsReadPick {
  readonly fieldsRead: OneArgument;
  readonly off: OneArgument;
}

/**
 * The keys of the object the pick reaches, or of every object in the
 * list it reaches, each key in the order first written. `under` reads
 * the objects under those properties of it instead, in that order.
 * `otherwise` is what a call that states no keys reads.
 */
export interface KeysOfPick {
  readonly keysOf: OneArgument;
  readonly under?: readonly string[];
  readonly otherwise?: readonly string[];
}

/** What one method of a storage client does. */
export interface StorageMethod {
  readonly kind: AccessKind;
  /**
   * Which argument says which operation the call performs, when the
   * method name does not. A project's own request helper needs this,
   * because every operation goes through the one function.
   */
  readonly operation?: ArgumentPick;
  /**
   * What the call reached: an argument the call passes, a rule the pack
   * wrote, or a fixed list for a method whose name already settles it.
   * `findById` picks by `_id` however the id is spelt.
   */
  readonly selector?: NamesStated;
  /**
   * Which fields the call touched, stated any of the ways a selector
   * is. A delete touches the whole document and states `["*"]`, since
   * nothing in its arguments says so.
   */
  readonly fields?: NamesStated;
}

/** Every way a storage method can say which names a call reached. */
export type NamesStated =
  | readonly string[]
  | ArgumentPick
  | SelectorParamPick
  | FieldsReadPick
  | KeysOfPick
  | InputRule
  | StatedRule;

/**
 * What one method of a client that takes a statement written as SQL
 * does. The statement says which tables it touches and what it does to
 * each, so the only thing a pack has to state is where the call puts
 * it.
 */
export interface SqlMethod {
  /**
   * Where the call states the statement. The pick's steps can reach a
   * call beside this one, so a pack can read a statement built as a
   * tagged template and passed to `execute`.
   *
   * A list is tried in order until one of the picks reaches text. Some
   * libraries take the statement either way: `query(sql)` and
   * `query({ query: sql })` are the same call, so the pack lists both
   * picks.
   */
  readonly statement: OneArgument | readonly OneArgument[];
  /**
   * Where the call passes the values the statement's placeholders take,
   * tried in order like `statement`: `query(sql, [id])` and
   * `query({ text: sql, values: [id] })`. Without it the access still
   * reads, and nothing says where a column's value came from.
   */
  readonly parameters?: OneArgument | readonly OneArgument[];
}

/** What one send method does, as the message-send ending reads it. */
export interface MessageSendMethod {
  /**
   * Where the call states the message, or the collection of them. Left
   * out when the message is the call's own arguments, `{ each: "theCall" }`,
   * and a method that leaves it out for any other location matches nothing.
   */
  readonly input?: OneArgument;
}

/**
 * What one invoke method does. An invoke states its whole request as
 * one object, so it says where that object is and nothing else.
 */
export interface UnitInvokeMethod {
  readonly input: OneArgument;
}

/**
 * Where a call states the function it hands over. A method lists its
 * picks in the order to try them, and the first one that finds a value
 * settles which function the call runs.
 */
export type CallbackPick = CallbackArgument | CallbackProperty | CallbackBlock;

/**
 * The argument at `at`, when the source writes a function there or a
 * name for one. Anything else there is not the callback: a name for an
 * object is the call's options, and `undefined` says the call passes no
 * function in that place.
 */
export interface CallbackArgument {
  readonly written: "callback";
  readonly at: number;
  /** The keyword the argument can be passed under instead, in Python or Ruby. */
  readonly keyword?: string;
}

/**
 * A property of the object the call writes out at `at`, read by the
 * object's own keys. An object passed by name, or a property that only
 * a spread brings in, is not read.
 */
export interface CallbackProperty {
  readonly written: "here";
  readonly at: number;
  /** The keyword the argument can be passed under instead, in Python or Ruby. */
  readonly keyword?: string;
  /** The properties to try, in order. */
  readonly property: readonly string[];
}

/** The block a Ruby call is written with. */
export interface CallbackBlock {
  readonly written: "block";
}

/** What one method that takes a callback does: where it states the callback. */
export interface CallbackMethod {
  readonly callback: CallbackPick | readonly CallbackPick[];
}

/**
 * Which stream one write method sends to: a stream the method always
 * writes to, as `console.error` writes to stderr, or `receiver` for the
 * stream the call is made on, as `process.stdout.write` is.
 */
export interface StreamWriteMethod {
  readonly to: string;
}

/**
 * What one table in a chain can say: what a method does, or for a read
 * chain what a read of an entry, a getter or an assignment is.
 */
export type MethodMeaning =
  | StorageMethod
  | SqlMethod
  | MessageSendMethod
  | CallbackMethod
  | StreamWriteMethod
  | EntryMeaning
  | GetterMeaning
  | WriteMeaning;

/** What a chain produces when every link matches. */
export type Ending =
  | StorageEnding
  | SqlEnding
  | MessageSendEnding
  | UnitInvokeEnding
  | ScheduleEnding
  | StreamWriteEnding
  | RuntimeReadEnding;

/**
 * A write to one of the process's own output streams. Nothing pairs
 * against it, since whoever reads a stream is a person or a shell.
 */
export interface StreamWriteEnding {
  readonly yields: "streamWrite";
  /**
   * Each global path a receiver can be, and the stream it is: `{
   * "process.stdout": "stdout" }`. A method whose `to` is `receiver`
   * writes to the stream its receiver's path gives here.
   */
  readonly streams: Readonly<Record<string, string>>;
}

/**
 * A callback the call hands to a library that runs it later. Nothing
 * pairs against it. The effect says which function runs, so a reader
 * can follow it there.
 */
export interface ScheduleEnding {
  readonly yields: "schedule";
  /** Where the effect's `via` comes from: the callee as the source writes it. */
  readonly via: "asWritten";
  /** What the effect says when the run cannot tell which function runs. */
  readonly unread: ScheduleUnread;
}

/** The reasons an effect gives when the run cannot tell which function the call runs. */
export interface ScheduleUnread {
  /** No pick found a value. */
  readonly missing: string;
  /** A pick found a value that is neither a function written in place nor a name. */
  readonly other: string;
}

/**
 * The store as the pack states it, or as the project the call's file
 * belongs to says, for a library whose projects each say which database
 * they use.
 */
export type StorageSystem = string | ProjectSystem;

export interface ProjectSystem {
  /** The store for the file a call is in, or null when the project does not say. */
  readonly byFile: LinkFunction<[string], string | null>;
  /** The store for a call whose project does not say. */
  readonly otherwise: string;
}

/** A storage access: one call, one thing it read or wrote. */
export interface StorageEnding {
  readonly yields: "storageAccess";
  /** The store, in the words OpenTelemetry's semantic conventions use. */
  readonly system: StorageSystem;
  /** The wire, when it differs from the store's own name. */
  readonly transport?: string;
  /** Which of the store's namespaces the call reached. */
  readonly scope: string;
  /** What a reader gives back for a name nothing in the source settles. */
  readonly unsettledName: "nothing" | "reference";
}

/**
 * Every table a statement touches, as one effect each.
 *
 * The other endings settle what a call reached from the call's
 * arguments. This one reads the statement, so one call yields one
 * effect per table, each with its own kind. A statement that writes one
 * table while reading another yields a write and a read.
 */
export interface SqlEnding {
  readonly yields: "sqlAccess";
  /** The store, in the words OpenTelemetry's semantic conventions use. */
  readonly system: StorageSystem;
  /** The wire, when it differs from the store's own name. */
  readonly transport?: string;
  /** Which of the store's namespaces the call reached. */
  readonly scope: string;
  /**
   * Which dialect the statements are written in. A pack states it
   * outright because nothing here can work it out: a Cloudflare D1
   * database is a store of its own whose statements are SQLite, and a
   * reader that guessed Postgres for a MySQL project would report the
   * wrong tables rather than none.
   */
  readonly dialect: StorageSystem;
  /**
   * Which walk the chain runs on. The access walk is the default, since
   * it also visits a statement written as a tagged template. A client
   * that only ever takes its statement as an argument can run on the
   * invocation walk, which keeps its accesses among the call effects.
   */
  readonly walk?: "invocation" | "access";
}

/**
 * Where the messages a call sends are written.
 *
 * A library takes one message as the call's input, or a collection of
 * them on a property or as the input. Which one applies depends on the
 * command, so a library offering both gets two declarations. SQS has
 * `SendMessageCommand` and `SendMessageBatchCommand`, and their inputs
 * differ.
 */
export type MessageLocation = OneMessage | ManyIn | ManyAsTheInput | TheCall;

/** The call's input is the message. */
export interface OneMessage {
  readonly each: "theInput";
}

/** A property of the call's input contains the messages, one each. */
export interface ManyIn {
  readonly each: "in";
  /** The property the collection is written on. */
  readonly property: string;
}

/** The call's input is the list of messages, as in BullMQ's `addBulk([...])`. */
export interface ManyAsTheInput {
  readonly each: "inTheInput";
}

/**
 * The call sends one message spread over its own arguments, as a
 * project's `dispatch(subject, body)` does. There is no one value to
 * read the message off, so its channel and its body are each an
 * argument.
 */
export interface TheCall {
  readonly each: "theCall";
}

/**
 * One part of the channel a message goes to. SQS has a queue, and
 * EventBridge has a bus and a subject on it, so a pack states the parts
 * in the order they join.
 */
export type ChannelPart = PropertyPart | ArgumentPart;

/**
 * A part the call states as an argument, usually of a call next to it.
 * A BullMQ queue takes its name when it is built, so the pack reads
 * `{ of: [{ to: "receiver" }], at: 0 }`.
 */
export interface ArgumentPart {
  readonly argument: OneArgument;
  /** What a reader gives back when nothing in the source settles it. */
  readonly unsettled?: UnsettledName;
}

/** A part the message, or the call's input, states as a property. */
export interface PropertyPart {
  /**
   * The properties the message may state this part on, tried in order.
   * A library that lets one destination be written more than one way
   * lists each spelling: an SNS publish writes its topic as `TopicArn`
   * or as `TargetArn`, and the two are the same part of the channel.
   */
  readonly property: readonly string[];
  /**
   * Where the property is written. A batch command states the queue
   * once beside the list of messages, so its channel part reads off
   * the call's input while the messages come one entry at a time.
   * Defaults to the message.
   */
  readonly on?: "theMessage" | "theInput";
  /** What the library uses when the message leaves this part out. */
  readonly whenAbsent?: string;
  /**
   * What a reader gives back when this part is written but nothing in
   * the source settles it, overriding the ending's `unsettledName`.
   * EventBridge needs both settings. Its bus is nearly always an env
   * var, whose name both sides of the boundary agree on. Its subject is
   * a domain string, and a value known only at run time there should
   * leave the channel unnamed so it does not pair against everything.
   */
  readonly unsettled?: UnsettledName;
}

/** A message sent on a wire, which pairs with whatever consumes that channel. */
export interface MessageSendEnding {
  readonly yields: "messageSend";
  /** The wire, in the words the IR's message-bus semantics use. */
  readonly wire: MessageBusSemantics["messageBus"];
  /** Where the messages are. */
  readonly messages: MessageLocation;
  /** The parts of the channel, joined in the order they are written. */
  readonly channel: readonly ChannelPart[];
  /** What joins the parts, when there is more than one. */
  readonly channelSeparator?: string;
  /**
   * The property the message states its body on, the whole message, or
   * an argument of the call, when the pack can say. `queue.add(name,
   * data)` hands the body over as its own argument, so the message is the
   * body.
   */
  readonly body?: string | WholeMessage | ArgumentBody;
  /**
   * Where the literal value recorded as the routing key is: a property
   * of the message, or an argument of the call. It stays out of the
   * channel, so a reader can filter on it but the two sides do not
   * pair on it.
   */
  readonly routingKey?: string | OneArgument;
  /**
   * What a reader gives back for a channel nothing in the source
   * settles. A queue URL only exists at deploy time, so the code writes
   * `process.env.ORDERS_QUEUE_URL` and the env var's name is what both
   * sides of the boundary agree on. `"reference"` keeps that name.
   */
  readonly unsettledName: UnsettledName;
}

/** The message itself, as the body a send records. */
export interface WholeMessage {
  readonly whole: "message";
}

/** An argument of the call, as the body a send records. */
export interface ArgumentBody {
  readonly argument: OneArgument;
}

/**
 * A call that hands a payload to one deployed unit, named on the call.
 *
 * The unit's name is read off the call's own input rather than off a
 * message, because there is one callee per call however many messages a
 * send takes. A name written as a fully-qualified cloud id is reduced
 * to the resource segment, so an ARN and a bare name come out the same.
 */
export interface UnitInvokeEnding {
  readonly yields: "unitInvoke";
  /** The platform running the unit, in the IR's deployable-unit words. */
  readonly platform: DeployableUnit["deploymentTarget"];
  /** The properties the call may name the unit on, tried in order. */
  readonly named: readonly string[];
  /** The property the call states its payload on, when the pack can say. */
  readonly payload?: string;
  /**
   * What a reader gives back for a name nothing in the source settles.
   * A function name usually arrives through an env var, whose name both
   * sides agree on, so `"reference"` keeps it.
   */
  readonly unsettledName: UnsettledName;
}

/**
 * A pack's declaration for one kind of call: the links, the ending, and
 * a line of code it matches.
 */
export interface Chain<TMeaning = MethodMeaning> {
  readonly links: readonly Link<TMeaning>[];
  readonly ending: Ending;
  /** A line of code this matches, which the pack's tests run. */
  readonly example: string | null;
}
