/**
 * Background jobs: the method a worker runs later, and the calls that
 * enqueue it.
 *
 * A class whose ancestry reaches one of a job pattern's base classes, or
 * mixes in one of its modules, is a job. The method the worker runs
 * becomes a `consumer` unit bound to a message-bus channel, and a call
 * that enqueues the job becomes a `message-send` to that channel with the
 * job's arguments. Both sides decide whether a class is a job through the
 * same ancestry rules, so they agree on the channel. An enqueue whose job
 * the rules do not settle is recorded with no channel, and the summary
 * gets a gap for it. DESIGN.md has the spellings each kind reads.
 */

import { dispatchByType, messageBusBinding } from "@suss/behavioral-ir";
import { formatChannel } from "@suss/ir-core";

import {
  argumentAt,
  children,
  definesClassMethod,
  field,
  instanceMethodsByName,
  instanceMethodVisibility,
  rangeOf,
  readCallArgs,
  runStatements,
  symbolValue,
} from "./ast.js";
import {
  classBehind,
  classSettledOn,
  declaredName,
  enclosingClassKey,
  methodRunOn,
  mixesIn,
  reachesBase,
} from "./baseClass.js";
import { nodeId, readKey } from "./facts/values.js";
import { argOf } from "./paths/effects.js";
import { compoundName } from "./scope.js";
import { stringValueOf } from "./values/evaluator.js";

import type { DispatchTable, Effect } from "@suss/behavioral-ir";
import type { Database } from "@suss/datalog";
import type { BodyBlocks } from "./ast.js";
import type {
  RbJobClasses,
  RbJobPattern,
  RbMailers,
  RubyPack,
} from "./pack.js";
import type { RbNode } from "./parser.js";
import type { EffectAt } from "./paths/effects.js";
import type { ClassInfo } from "./scope.js";

/** One job pattern, with the pack that declared it, which its effects and units are recognized as. */
export interface RbJobDeclaration {
  readonly pattern: RbJobPattern;
  readonly recognition: string;
}

export interface RbJobOptions {
  readonly facts: Database;
  readonly declarations: readonly RbJobDeclaration[];
}

/** Every job pattern the run's packs declare, each with its pack's name. */
export function jobDeclarationsIn(
  packs: readonly RubyPack[],
): RbJobDeclaration[] {
  return packs.flatMap((pack) =>
    (pack.jobs ?? []).map((pattern) => ({ pattern, recognition: pack.name })),
  );
}

// ---------------------------------------------------------------------------
// The job's side
// ---------------------------------------------------------------------------

/** A method a worker runs, and the channel its unit is bound to. */
export interface JobHandler {
  /** The function's key in the facts. An inherited `perform` is written in another class, and often in another file. */
  readonly functionKey: string;
  /** The unit's name, `ReportExportJob#perform`. */
  readonly name: string;
  readonly exportPath: string[];
  readonly declaration: RbJobDeclaration;
  readonly channel: string;
}

/**
 * The methods a worker runs in one class block, for each pattern the
 * class is a job of. `file` is the absolute path the class was read from.
 */
export function jobHandlersOf(
  info: ClassInfo,
  file: string,
  options: RbJobOptions,
  bodyBlocks: BodyBlocks | undefined,
): JobHandler[] {
  const body = info.bodyNode;
  if (body === null || info.kind !== "class") {
    return [];
  }
  const classKey = nodeId(file, info.node);
  const handlers: JobHandler[] = [];
  for (const declaration of options.declarations) {
    const { pattern } = declaration;
    if (
      pattern.baseClasses.includes(info.qualifiedName) ||
      !isJobOf(pattern, classKey, options.facts)
    ) {
      continue;
    }
    const read: HandlerRead = {
      info,
      file,
      classKey,
      body,
      declaration,
      facts: options.facts,
      bodyBlocks,
    };
    const table: DispatchTable<RbJobPattern, JobHandler[]> = {
      jobClasses: (p) => jobClassHandlers(p, read),
      mailers: () => mailerHandlers(read),
    };
    handlers.push(...dispatchByType(table, pattern));
  }
  return handlers;
}

interface HandlerRead {
  info: ClassInfo;
  file: string;
  classKey: string;
  body: RbNode;
  declaration: RbJobDeclaration;
  facts: Database;
  bodyBlocks: BodyBlocks | undefined;
}

/** The job's own `perform`, or the one it inherits from a base job. */
function jobClassHandlers(
  pattern: RbJobClasses,
  read: HandlerRead,
): JobHandler[] {
  const functionKey = methodRunOn(
    read.facts,
    read.classKey,
    pattern.performMethod,
  );
  if (functionKey === undefined) {
    return [];
  }
  const className = read.info.qualifiedName;
  return [
    {
      functionKey,
      name: `${className}#${pattern.performMethod}`,
      exportPath: [className, pattern.performMethod],
      declaration: read.declaration,
      channel: formatChannel(declaredQueue(pattern, read), className),
    },
  ];
}

/** Every public instance method a mailer defines is a message it can send. */
function mailerHandlers(read: HandlerRead): JobHandler[] {
  const className = read.info.qualifiedName;
  const visibility = instanceMethodVisibility(read.body);
  const handlers: JobHandler[] = [];
  for (const [name, method] of instanceMethodsByName(
    read.body,
    read.bodyBlocks,
  )) {
    if ((visibility.get(name) ?? "public") !== "public") {
      continue;
    }
    if (name === "initialize") {
      continue;
    }
    handlers.push({
      functionKey: nodeId(read.file, method),
      name: `${className}#${name}`,
      exportPath: [className, name],
      declaration: read.declaration,
      channel: mailerChannel(className, name),
    });
  }
  return handlers;
}

/** `UserMailer.welcome`. A `#` would read as a queue in front of the subject. */
function mailerChannel(className: string, message: string): string {
  return `${className}.${message}`;
}

/**
 * The queue the class body declares, or null when it declares none or
 * the queue is worked out at run time. A queue a base class declares is
 * left out, and a channel with no queue pairs with an enqueue on any.
 */
function declaredQueue(
  pattern: RbJobClasses,
  read: HandlerRead,
): string | null {
  for (const statement of runStatements(read.body)) {
    if (statement.type !== "call" || field(statement, "receiver") !== null) {
      continue;
    }
    const call = field(statement, "method")?.text;
    const declaration = pattern.queueDeclarations.find(
      (one) => one.call === call,
    );
    if (declaration === undefined) {
      continue;
    }
    const written = argumentAt(
      readCallArgs(field(statement, "arguments")),
      declaration.queue,
    );
    if (written === undefined) {
      continue;
    }
    return symbolValue(written) ?? stringValueOf(written, read.facts);
  }
  return null;
}

function isJobOf(
  pattern: RbJobPattern,
  classKey: string,
  facts: Database,
): boolean {
  const modules = pattern.type === "jobClasses" ? pattern.modules : [];
  return (
    reachesBase(facts, classKey, pattern.baseClasses) ||
    (modules.length > 0 && mixesIn(facts, classKey, modules))
  );
}

// ---------------------------------------------------------------------------
// The enqueuing side
// ---------------------------------------------------------------------------

/** A call that enqueues a job: the channel when the job settled, and the arguments the job is given. */
interface Enqueue {
  readonly declaration: RbJobDeclaration;
  readonly channel: string | null;
  readonly args: readonly RbNode[];
}

interface EnqueueRead {
  readonly file: string;
  readonly facts: Database;
  /** The method the call is written in, which keeps one method's locals apart from another's. */
  readonly enclosing: RbNode | null;
}

/** What a call enqueues, or null when it enqueues nothing a pack declares. */
function enqueueAt(
  call: RbNode,
  options: RbJobOptions,
  read: EnqueueRead,
): Enqueue | null {
  for (const declaration of options.declarations) {
    const table: DispatchTable<RbJobPattern, Enqueue | null> = {
      jobClasses: (p) => jobClassEnqueue(call, p, declaration, read),
      mailers: (p) => mailerEnqueue(call, p, declaration, read),
    };
    const found = dispatchByType(table, declaration.pattern);
    if (found !== null) {
      return found;
    }
  }
  return null;
}

/**
 * `ReportJob.perform_later(id)`, `ReportJob.set(wait: 5.minutes)
 * .perform_later(id)`, or a bare `perform_later(id)` in one of the job's
 * own class methods.
 */
function jobClassEnqueue(
  call: RbNode,
  pattern: RbJobClasses,
  declaration: RbJobDeclaration,
  read: EnqueueRead,
): Enqueue | null {
  const method = field(call, "method")?.text ?? "";
  const argumentsFrom = pattern.enqueueMethods[method];
  if (argumentsFrom === undefined) {
    return null;
  }
  const receiver = pastOptions(field(call, "receiver"), pattern.optionMethods);
  const classKey = classOfReceiver(receiver, call, read);
  const args = children(field(call, "arguments")).slice(argumentsFrom);
  if (classKey === undefined) {
    return { declaration, channel: null, args };
  }
  if (!isJobOf(pattern, classKey, read.facts)) {
    return null;
  }
  // The job's side has a unit only when its `perform` settles, so only
  // then does the send say which job, and it never lacks a consumer.
  const name = declaredName(read.facts, classKey);
  const runs = methodRunOn(read.facts, classKey, pattern.performMethod);
  return {
    declaration,
    channel:
      name === undefined || runs === undefined
        ? null
        : formatChannel(null, name),
    args,
  };
}

/** `UserMailer.welcome(user).deliver_later`, also with `.with(params)` in front of the message. */
function mailerEnqueue(
  call: RbNode,
  pattern: RbMailers,
  declaration: RbJobDeclaration,
  read: EnqueueRead,
): Enqueue | null {
  const method = field(call, "method")?.text ?? "";
  if (!pattern.enqueueMethods.includes(method)) {
    return null;
  }
  const message = field(call, "receiver");
  const messageName =
    message?.type === "call" ? field(message, "method")?.text : undefined;
  if (message === null || messageName === undefined) {
    return { declaration, channel: null, args: [] };
  }
  const args = children(field(message, "arguments"));
  const receiver = pastOptions(
    field(message, "receiver"),
    pattern.optionMethods,
  );
  const classKey = classOfReceiver(receiver, message, read);
  if (classKey === undefined) {
    return { declaration, channel: null, args };
  }
  if (!isJobOf(pattern, classKey, read.facts)) {
    return null;
  }
  // A mailer's units are the messages its own body defines, so only one
  // of those settles the send.
  const name = declaredName(read.facts, classKey);
  const declares = read.facts
    .lookup("holdsProperty", 0, classKey)
    .some((row) => String(row[1]) === messageName);
  return {
    declaration,
    channel:
      name === undefined || !declares ? null : mailerChannel(name, messageName),
    args,
  };
}

/** The receiver an option call such as `set(wait: 1.hour)` was made on, however many are chained. */
function pastOptions(
  receiver: RbNode | null,
  optionMethods: readonly string[],
): RbNode | null {
  let current = receiver;
  while (
    current !== null &&
    current.type === "call" &&
    optionMethods.includes(field(current, "method")?.text ?? "")
  ) {
    current = field(current, "receiver");
  }
  return current;
}

/**
 * The class a job is enqueued on. A constant goes through the constant
 * bindings, any other receiver through the rules. With no receiver, or
 * `self`, the call is on the class it is written in, when it is written
 * in one of that class's class methods.
 */
function classOfReceiver(
  receiver: RbNode | null,
  call: RbNode,
  read: EnqueueRead,
): string | undefined {
  if (receiver === null || receiver.type === "self") {
    if (read.enclosing === null || !definesClassMethod(read.enclosing)) {
      return undefined;
    }
    return enclosingClassKey(call, read.file) ?? undefined;
  }
  if (receiver.type === "constant" || receiver.type === "scope_resolution") {
    return classBehind(read.facts, read.file, receiver);
  }
  return classSettledOn(
    read.facts,
    readKey(read.file, receiver, read.enclosing),
  );
}

function enqueueEffect(
  call: RbNode,
  enqueue: Enqueue,
  facts: Database,
): Effect {
  return {
    type: "interaction",
    binding: messageBusBinding({
      recognition: enqueue.declaration.recognition,
      messageBus: enqueue.declaration.pattern.messageBus,
      channel: enqueue.channel,
    }),
    callee: calleeOf(call),
    interaction: {
      class: "message-send",
      body: {
        kind: "array",
        items: enqueue.args.map((arg) => argOf(arg, facts)),
      },
    },
    location: rangeOf(call),
  };
}

/** The call as written, without its arguments: `ReportJob.set(wait: 1.hour).perform_later`. */
function calleeOf(call: RbNode): string {
  const receiver = field(call, "receiver");
  const method = field(call, "method")?.text ?? "";
  if (receiver === null) {
    return method;
  }
  const written =
    receiver.type === "scope_resolution"
      ? compoundName(receiver)
      : receiver.text;
  return `${written}.${method}`;
}

/**
 * The jobs a method's body enqueues, one effect per call, settled or
 * not. `file` is the absolute path the method was read from.
 */
export function jobEnqueueEffects(
  method: RbNode,
  file: string,
  options: RbJobOptions | undefined,
): EffectAt[] {
  if (options === undefined || options.declarations.length === 0) {
    return [];
  }
  const read: EnqueueRead = { file, facts: options.facts, enclosing: method };
  const found: EffectAt[] = [];
  for (const call of callsUnder(method)) {
    const enqueue = enqueueAt(call, options, read);
    if (enqueue !== null) {
      found.push({
        effect: enqueueEffect(call, enqueue, options.facts),
        at: call,
      });
    }
  }
  return found;
}

/**
 * Whether a call is part of an enqueue the recognizer records, so the
 * walk reports no gap of its own for it: the enqueue itself, and the
 * calls its chain is built from, such as the `UserMailer.welcome` that
 * `deliver_later` is called on.
 */
export function jobClaims(
  call: RbNode,
  file: string,
  options: RbJobOptions | undefined,
  enclosing: RbNode | null,
): boolean {
  if (options === undefined || options.declarations.length === 0) {
    return false;
  }
  const read: EnqueueRead = { file, facts: options.facts, enclosing };
  let current: RbNode | null = call;
  while (current !== null && current.type === "call") {
    if (enqueueAt(current, options, read) !== null) {
      return true;
    }
    const parent: RbNode | null = current.parent;
    if (parent === null || field(parent, "receiver")?.id !== current.id) {
      return false;
    }
    current = parent;
  }
  return false;
}

function callsUnder(node: RbNode, found: RbNode[] = []): RbNode[] {
  for (const child of children(node)) {
    if (child.type === "call") {
      found.push(child);
    }
    callsUnder(child, found);
  }
  return found;
}
