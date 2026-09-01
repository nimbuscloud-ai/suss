/**
 * The spine every pack shares, as a chain of links.
 *
 * A pack does four jobs, and all four start the same way: match the
 * receiver, match the method, read the arguments, then yield. What
 * differs is the ending. Recognition yields effects, discovery yields a
 * unit, a terminal yields a response write, and a claimed callback
 * yields a sub-unit. Two recognition endings are built, one that asks
 * the call what it reached and one that reads the statement the call
 * was handed; the other three jobs are further members of `Ending`
 * with an entry in the compile table.
 *
 * A link's answer is data wherever it can be. A link given a function
 * instead is code, that link alone, and pack health says which ones.
 */

import type { DeployableUnit, MessageBusSemantics } from "@suss/behavioral-ir";
import type {
  CallOps,
  ReceiverOrigin,
  UnsettledName,
  ValueOps,
} from "./ops.js";

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

/**
 * The link a chain opens with, when the pack says which client its calls
 * are on. A pack that names no client matches the method wherever it is
 * written, which is what a global send does.
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
  /**
   * Where the argument has to have come from, for a step that tries
   * several. `send(command)` takes one argument and a presigner takes
   * two, and the one that matters is the command the SDK declares, so
   * the step says so rather than reading whatever it lands on.
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
 * The container worked out by the pack. The call the chain is about
 * comes second so that a rule written over the selector alone, which is
 * most of them, ignores it. A rule that has to read the syntax tree
 * goes through `astLink`, which is what puts the call to use.
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
   * What one of them is. An entry keys the container by name and says
   * what the call did there, which is how a batch write is written. A
   * name is the container on its own, which is how a call that reads
   * several parameters at once is written. Defaults to an entry.
   */
  readonly each?: "entry" | "name";
}

/**
 * Where a call states its inputs, when it states them as one object
 * rather than as positional arguments. A call that states none is not
 * one of these calls, so the chain stops there, and a rule the pack
 * writes over the inputs is handed the object rather than a position to
 * go looking in.
 */
export interface InputLink {
  readonly asks: "input";
  readonly at: OneArgument;
}

/**
 * What the values a statement interpolates come to.
 *
 * A query that says which table it reached by handing over the schema
 * object leaves the name out of the text, and a parameter in its place
 * does not parse. Only the pack knows the object is a table rather than
 * a value, so the pack says which argument of the call behind it gives
 * the name, and where that call had to have come from.
 */
export interface InterpolatesLink {
  readonly asks: "interpolates";
  /** Which argument of the call the value was written as gives the name. */
  readonly named: ArgumentPick;
  /** Where the value had to have come from. Left out, every hole is read. */
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
  | ContainersLink
  | InputLink
  | InterpolatesLink;

/**
 * The meaning of a bare call of the tracked client itself. A store
 * hook is the case: `useAppStore((s) => s.bears)` reaches for no
 * method, so there is no name for a methods table to list; the call
 * matches by what its callee was written as.
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
  /**
   * What it comes to when the call says nothing. Left out, a call that
   * asks for something the table does not list is not one of these
   * calls, which is how a pack reads a helper whose operations a
   * project lists in its own config.
   */
  readonly otherwise?: "read" | "write";
}

/** What a pack's own rule is handed: one value, and what the call does. */
export interface StatedInputs {
  /**
   * The value the rule reads. That is the object the call states its
   * inputs as when the chain says where with `input`, and the value the
   * rule was pointed at when it says where for itself. A call that
   * passed nothing there states nothing, rather than the rule being
   * skipped: a projection the caller left out is still a read of every
   * field there is, and only the pack knows that.
   */
  readonly input: ValueOps;
  /** The container's own entry, when the call reached several. */
  readonly entry: ValueOps | null;
  /** What the call does to the store. */
  readonly kind: "read" | "write";
}

/**
 * A pack's own rule over the inputs a call states, for a library that
 * writes what a reader wants somewhere no pick can reach.
 */
export type InputRule = LinkFunction<[StatedInputs], readonly string[]>;

/**
 * A pack's own rule, pointed at the value it reads.
 *
 * `input` says where a call that states one request object states it,
 * and every rule on that chain reads the one value. A library that
 * spreads what a reader wants over several places needs each rule
 * pointed somewhere of its own: Mongoose picks documents by the first
 * argument and reads the fields the second asks for, and Drizzle puts
 * the fields, the table and the condition on three calls of one chain,
 * which the pick's own `of` steps reach.
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
   * name the call goes to does not. A project's own request helper is
   * the case: every operation goes through the one function.
   */
  readonly operation?: ArgumentPick;
  /**
   * What the call reached. An argument the call passes, a rule the pack
   * wrote, or the plain list a method whose own name settles it states
   * outright: `findById` picks by `_id` however the id is spelt.
   */
  readonly selector?:
    | readonly string[]
    | ArgumentPick
    | SelectorParamPick
    | InputRule
    | StatedRule;
  /**
   * Which fields the call touched, said the same three ways. A delete
   * touches the whole document and states `["*"]`, since nothing in its
   * arguments says so.
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
   * Where the call states the statement. The pick's steps reach a call
   * beside this one, which is how a pack reads a statement handed to
   * `execute` as a tagged template rather than written on the call.
   */
  readonly statement: OneArgument;
}

/** What one method table can say a method does. */
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
 * The other ending settles what a call reached by asking the call. This
 * one settles it by reading the statement, so one call yields as many
 * effects as the statement has tables, and each of them states its own
 * kind: a statement that writes one table while reading another says
 * both.
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
 * collection of them under a property. Which of the two is a fact about
 * the command, so a library offering both spells them as two
 * declarations rather than one with a setting on it: SQS has
 * `SendMessageCommand` and `SendMessageBatchCommand`, and they are
 * different shapes.
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
   * EventBridge wants both: its bus is nearly always an env var, whose
   * name both sides of the boundary agree on, and its subject is a
   * domain string, where a run-time value should leave the channel
   * unnamed rather than pair against everything.
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
   * The property whose literal value rides along as the routing key.
   * Not part of the channel: it scopes the message for a reader without
   * being what the two sides pair on.
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
