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

import type { DeployableUnit, MessageBusSemantics } from "@suss/behavioral-ir";
import type {
  CallOps,
  ReceiverOrigin,
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
}

/**
 * The link a chain opens with, when the pack says which client its calls
 * are on. Without a client the chain matches the method on any receiver,
 * as a global send needs.
 */
export function chainStart<TMeaning>(
  client: ReceiverOrigin | undefined,
): Link<TMeaning>[] {
  return client === undefined
    ? []
    : [{ asks: "start", at: { starts: "receiver", origin: client } }];
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
export type CallStep = ToReceiver | ToArgument;

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
  | InterpolatesLink;

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
  readonly selector?:
    | readonly string[]
    | ArgumentPick
    | SelectorParamPick
    | InputRule
    | StatedRule;
  /**
   * Which fields the call touched, stated any of the ways a selector
   * is. A delete touches the whole document and states `["*"]`, since
   * nothing in its arguments says so.
   */
  readonly fields?:
    | readonly string[]
    | ArgumentPick
    | SelectorParamPick
    | InputRule
    | StatedRule;
}

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
}

/** What one send method does, as the message-send ending reads it. */
export interface MessageSendMethod {
  /** Where the call states the message, or the collection of them. */
  readonly input: OneArgument;
}

/**
 * What one invoke method does. An invoke states its whole request as
 * one object the same way a send does, so both say where that object
 * is and nothing else.
 */
export type UnitInvokeMethod = MessageSendMethod;

/** What one method table can say a method does. */
export type MethodMeaning = StorageMethod | SqlMethod | MessageSendMethod;

/** What a chain produces when every link matches. */
export type Ending =
  | StorageEnding
  | SqlEnding
  | MessageSendEnding
  | UnitInvokeEnding;

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
  readonly system: string;
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
  readonly dialect: string;
}

/**
 * Where the messages a call sends are written.
 *
 * A library either takes one message as the call's input or takes a
 * collection of them under a property. Which one applies depends on the
 * command, so a library offering both gets two declarations. SQS has
 * `SendMessageCommand` and `SendMessageBatchCommand`, and their inputs
 * differ.
 */
export type MessageLocation = OneMessage | ManyIn;

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

/**
 * One part of the channel a message goes to, read off the message.
 *
 * A channel is one name on some wires and several on others. SQS has a
 * queue, EventBridge has a bus and a subject on it, and both are read
 * the same way, so a pack states the parts in the order they join.
 */
export interface ChannelPart {
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
  /** The property the message states its body on, when the pack can say. */
  readonly body?: string;
  /**
   * The property whose literal value is recorded as the routing key. It
   * stays out of the channel, so a reader can filter on it but the two
   * sides do not pair on it.
   */
  readonly routingKey?: string;
  /**
   * What a reader gives back for a channel nothing in the source
   * settles. A queue URL only exists at deploy time, so the code writes
   * `process.env.ORDERS_QUEUE_URL` and the env var's name is what both
   * sides of the boundary agree on. `"reference"` keeps that name.
   */
  readonly unsettledName: UnsettledName;
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
