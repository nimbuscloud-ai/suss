/**
 * Background jobs: the functions a job library runs off a queue, and the
 * calls that put one on it. A pack lists the library's names under
 * `jobQueues`, and this module reads them the way Python resolves them.
 *
 * A function under a task decorator becomes a consumer unit bound to the
 * task's channel. A call such as `send_report.delay(id)` becomes a
 * `message-send` once its receiver resolves to one task function. Both
 * sides get the task's name from `declaredTask`, so they always agree.
 * When the receiver does not settle on one task, the send has no
 * channel, and the extractor leaves an `unsettledJob` gap for it.
 * DESIGN.md lists the cases.
 */

import { dispatchByType, messageBusBinding } from "@suss/behavioral-ir";
import { callSiteKey, numberRepeatedCallSites } from "@suss/extractor";
import { formatChannel } from "@suss/ir-core";
import { calleeOutcomeOf, fileOfKey, noteKeyRead } from "@suss/resolution";

import { children, field, rangeOf, stripDecorators } from "./ast.js";
import {
  classifyDecorator,
  decoratorReceiver,
  unwrapDecorator,
} from "./decorators.js";
import { callArguments } from "./facts/values.js";
import { dottedModuleOf } from "./moduleResolver.js";
import { argOf, bodyCalls, calleeText } from "./paths/effects.js";
import { libraryUnit } from "./reach/closure.js";
import { reachedFunctionOf } from "./reach/resolveCallee.js";
import {
  askWrittenValues,
  constructionBehind,
  moduleOf,
  nodeOfResolutionKey,
  resolutionKeyOf,
  stringValueOf,
} from "./values/evaluator.js";
import { originOf } from "./values/origin.js";

import type { DispatchTable, Effect } from "@suss/behavioral-ir";
import type { Database } from "@suss/datalog";
import type { EffectArg, RawCodeStructure } from "@suss/extractor";
import type { DecoratorClassification } from "./decorators.js";
import type { CallArgument } from "./facts/values.js";
import type {
  PyCallArgument,
  PyDefaultTaskName,
  PyJobQueue,
  PyTaskArguments,
  PythonPack,
} from "./pack.js";
import type { PyNode } from "./parser.js";
import type { EffectAt } from "./paths/effects.js";
import type { ReachOptions } from "./reach/closure.js";
import type { BoundPythonFile } from "./routers.js";
import type { BuiltValue } from "./values/evaluator.js";

/** One pack's job library, with the pack's name for the bindings it makes. */
interface JobQueueEntry {
  readonly recognition: string;
  readonly pattern: PyJobQueue;
}

/** The run's job libraries, and the roots a task's module path is read under. */
interface JobQueueRun {
  readonly entries: readonly JobQueueEntry[];
  readonly roots: readonly string[];
}

const runs = new WeakMap<Database, JobQueueRun>();

/** The job libraries the run's packs declare. */
export function jobQueueEntries(packs: readonly PythonPack[]): JobQueueEntry[] {
  return packs.flatMap((pack) =>
    (pack.jobQueues ?? []).map((pattern) => ({
      recognition: pack.name,
      pattern,
    })),
  );
}

/** Register the run's job libraries, so every reader over `db` finds them. */
export function bindJobQueues(
  db: Database,
  packs: readonly PythonPack[],
  roots: readonly string[],
): void {
  const entries = jobQueueEntries(packs);
  if (entries.length > 0) {
    runs.set(db, { entries, roots });
  }
}

/** A function a job library runs, and what it is called. */
export interface DeclaredTask {
  readonly recognition: string;
  readonly pattern: PyJobQueue;
  /** The task's name, which an enqueue of it is sent to. Null when the name the decorator gives does not settle. */
  readonly name: string | null;
  /** The queue the decorator gives, which goes in front of the name on the consumer's channel. */
  readonly queue: string | null;
}

/**
 * The task a function is, when one of a job library's task decorators is
 * written on it, directly or through a project wrapper. `file` is the
 * function's absolute path.
 */
export function declaredTask(
  definition: PyNode,
  file: string,
  facts: Database,
): DeclaredTask | null {
  const run = runs.get(facts);
  const decorated = definition.parent;
  if (run === undefined || decorated?.type !== "decorated_definition") {
    return null;
  }
  const module = moduleOf(definition);
  for (const decorator of stripDecorators(decorated).decorators) {
    const found =
      taskDecoratorOf(classifyDecorator(decorator, module, facts), run) ??
      taskDecoratorOf(unwrapDecorator(decorator, facts), run);
    if (found === null) {
      continue;
    }
    const { entry, classification } = found;
    return {
      recognition: entry.recognition,
      pattern: entry.pattern,
      name: taskName(entry.pattern, classification, {
        file,
        definition,
        roots: run.roots,
        facts,
      }),
      queue: keywordString(classification, entry.pattern.queueKeyword, facts),
    };
  }
  return null;
}

function taskDecoratorOf(
  classification: DecoratorClassification | null,
  run: JobQueueRun,
): { entry: JobQueueEntry; classification: DecoratorClassification } | null {
  const importedName = classification?.importedName ?? null;
  if (classification === null || importedName === null) {
    return null;
  }
  const entry = run.entries.find(
    ({ pattern }) =>
      pattern.module === classification.module &&
      pattern.taskDecorators.includes(importedName),
  );
  return entry === undefined ? null : { entry, classification };
}

/** The string a decorator keyword settles on, or null when it is not written or does not settle. */
function keywordString(
  classification: DecoratorClassification,
  keyword: string,
  facts: Database,
): string | null {
  const written = classification.keywordArgs[keyword];
  return written === undefined ? null : stringValueOf(written.node, facts);
}

interface TaskPlace {
  readonly file: string;
  readonly definition: PyNode;
  readonly roots: readonly string[];
  readonly facts: Database;
}

function taskName(
  pattern: PyJobQueue,
  classification: DecoratorClassification,
  place: TaskPlace,
): string | null {
  if (classification.keywordArgs[pattern.nameKeyword] !== undefined) {
    return keywordString(classification, pattern.nameKeyword, place.facts);
  }
  return DEFAULT_TASK_NAME[pattern.defaultName](place);
}

const DEFAULT_TASK_NAME: Record<
  PyDefaultTaskName,
  (place: TaskPlace) => string | null
> = {
  modulePath: ({ file, definition, roots }) => {
    const dotted = dottedModuleOf(file, { roots: [...roots] });
    const name = field(definition, "name")?.text;
    return dotted === null || name === undefined ? null : `${dotted}.${name}`;
  },
};

/** The task's own channel, with the queue it declares in front. */
function consumedChannel(task: DeclaredTask): string | null {
  return task.name === null ? null : formatChannel(task.queue, task.name);
}

/**
 * A consumer unit on every task function in the file. Its body is read
 * the way a reached function's is, and the call walk starts from it.
 */
export function jobConsumerUnits(
  file: BoundPythonFile,
  options: Pick<ReachOptions, "storageFor" | "facts" | "tests">,
): RawCodeStructure[] {
  const { facts } = options;
  if (!runs.has(facts)) {
    return [];
  }
  const decorated = file.root.descendantsOfType("decorated_definition");
  askWrittenValues(
    decorated.flatMap((one) =>
      stripDecorators(one)
        .decorators.map((decorator) => decoratorReceiver(decorator)?.object)
        .filter((object): object is PyNode => object !== undefined),
    ),
    facts,
  );
  return decorated.flatMap((one) => {
    const { definition } = stripDecorators(one);
    const task =
      definition.type === "function_definition"
        ? declaredTask(definition, file.file, facts)
        : null;
    if (task === null) {
      return [];
    }
    const raw = libraryUnit(
      reachedFunctionOf(file, definition),
      options,
      messageBusBinding({
        recognition: task.recognition,
        messageBus: task.pattern.messageBus,
        channel: consumedChannel(task),
      }),
    );
    return [{ ...raw, identity: { ...raw.identity, kind: "consumer" } }];
  });
}

/** One call that puts a job on a queue, with the send recorded for it. */
export interface Enqueue {
  readonly call: PyNode;
  readonly effect: Effect;
}

/**
 * Every call among these that enqueues a job, settled or not. A call
 * whose receiver the run can tell is not a task, such as a
 * `multiprocessing` pool's `apply_async`, is left out.
 */
export function enqueuesAmong(
  calls: readonly PyNode[],
  facts: Database | undefined,
): Enqueue[] {
  const run = facts === undefined ? undefined : runs.get(facts);
  if (facts === undefined || run === undefined) {
    return [];
  }
  return calls.flatMap((call) => {
    const effect = enqueueAt(call, run, facts);
    return effect === null ? [] : [{ call, effect }];
  });
}

/** The sends a function's own body makes. */
export function enqueueEffects(
  definition: PyNode,
  facts: Database | undefined,
): EffectAt[] {
  const body = field(definition, "body");
  // The grammar writes a body on every def.
  /* v8 ignore start */
  if (body === null) {
    return [];
  }
  /* v8 ignore stop */
  return numberRepeatedCallSites(
    enqueuesAmong(bodyCalls(body), facts).map(({ call, effect }) => [
      { effect, at: call },
    ]),
  ).flat();
}

function enqueueAt(
  call: PyNode,
  run: JobQueueRun,
  facts: Database,
): Effect | null {
  const callee = field(call, "function");
  const receiver =
    callee?.type === "attribute" ? field(callee, "object") : null;
  const method = callee === null ? undefined : field(callee, "attribute")?.text;
  if (receiver === null || method === undefined) {
    return null;
  }
  for (const entry of run.entries) {
    const enqueue = entry.pattern.enqueueMethods.find(
      (one) => one.method === method,
    );
    if (enqueue !== undefined) {
      return taskEnqueue(call, receiver, enqueue.arguments, entry, facts);
    }
    const byName = (entry.pattern.sendByName ?? []).find(
      (one) => one.method === method,
    );
    if (byName !== undefined && isApp(receiver, entry.pattern, facts)) {
      const name = argumentAt(callArguments(call), byName.name);
      return sendEffect(call, entry, {
        channel: name === null ? null : stringValueOf(name, facts),
        body: taskArguments(call, byName.arguments, facts),
      });
    }
  }
  return null;
}

/** What a receiver turned out to be: one task, something that is not a task, or a value the run cannot settle. */
type TaskReading =
  | { type: "oneTask"; task: DeclaredTask }
  | { type: "notTask" }
  | { type: "unsettled" };

function taskEnqueue(
  call: PyNode,
  receiver: PyNode,
  args: PyTaskArguments,
  entry: JobQueueEntry,
  facts: Database,
): Effect | null {
  const reading = taskBehind(receiver, entry.pattern, facts);
  if (reading.type === "notTask") {
    return null;
  }
  return sendEffect(call, entry, {
    channel: reading.type === "oneTask" ? reading.task.name : null,
    body: taskArguments(call, args, facts),
  });
}

/**
 * The task a receiver resolves to through the rules. A value built by a
 * call into some other library is not a task, and a function is one only
 * when a task decorator is written on it.
 */
function taskBehind(
  receiver: PyNode,
  pattern: PyJobQueue,
  facts: Database,
): TaskReading {
  if (
    originsOfConstruction(constructionBehind(receiver, facts)).some(
      (origin) => origin.module !== pattern.module,
    )
  ) {
    return { type: "notTask" };
  }
  const key = resolutionKeyOf(receiver, facts);
  const outcome = key === null ? null : calleeOutcomeOf(facts, key);
  if (outcome?.kind !== "function") {
    return { type: "unsettled" };
  }
  noteKeyRead(facts, outcome.key);
  const definition = nodeOfResolutionKey(outcome.key, facts);
  const task =
    definition === null
      ? null
      : declaredTask(definition, fileOfKey(outcome.key), facts);
  return task === null ? { type: "notTask" } : { type: "oneTask", task };
}

interface ConstructorOrigin {
  readonly module: string;
  readonly name: string;
}

const ORIGINS_OF: DispatchTable<BuiltValue, ConstructorOrigin[]> = {
  noCall: () => [],
  oneCall: ({ construction }) => [construction.origin],
  severalCalls: ({ constructions }) => constructions.map((one) => one.origin),
};

function originsOfConstruction(built: BuiltValue): ConstructorOrigin[] {
  return dispatchByType(ORIGINS_OF, built);
}

/** Whether a receiver is the library's app: built by its class, or one of the objects the library exports for it. */
function isApp(
  receiver: PyNode,
  pattern: PyJobQueue,
  facts: Database,
): boolean {
  const isAppOrigin = (origin: ConstructorOrigin): boolean =>
    origin.module === pattern.module && pattern.apps.includes(origin.name);
  const built = originsOfConstruction(constructionBehind(receiver, facts));
  if (built.length > 0) {
    return built.every(isAppOrigin);
  }
  const imported = originOf(receiver, moduleOf(receiver));
  return imported !== null && isAppOrigin(imported);
}

function sendEffect(
  call: PyNode,
  entry: JobQueueEntry,
  sent: { channel: string | null; body: EffectArg | undefined },
): Effect {
  const effect: Effect = {
    type: "interaction",
    binding: messageBusBinding({
      recognition: entry.recognition,
      messageBus: entry.pattern.messageBus,
      channel: sent.channel,
    }),
    callee: calleeText(call),
    interaction: {
      class: "message-send",
      ...(sent.body === undefined ? {} : { body: sent.body }),
    },
    location: rangeOf(call),
  };
  return { ...effect, groupId: callSiteKey(effect) };
}

/** The node written at a place, by keyword first and then by position. */
function argumentAt(
  written: readonly CallArgument[],
  place: PyCallArgument,
): PyNode | null {
  const byKeyword = written.find(
    (one) => one.kind === "keyword" && one.name === place.keyword,
  );
  const byPosition = written.find(
    (one) => one.kind === "positional" && one.position === place.argument,
  );
  return (byKeyword ?? byPosition)?.node ?? null;
}

/**
 * What the task is handed, as one value: the positional arguments as an
 * array, the keyword ones as an object, and a pair of the two when the
 * call passes both, the way Celery's message sends them. Undefined when
 * a `*` or `**` hides what is passed.
 */
function taskArguments(
  call: PyNode,
  args: PyTaskArguments,
  facts: Database,
): EffectArg | undefined {
  const table: DispatchTable<PyTaskArguments, EffectArg | undefined> = {
    spread: () => spreadArguments(call, facts),
    packed: (packed) => packedArguments(call, packed, facts),
  };
  return dispatchByType(table, args);
}

const SPLAT_TYPES = new Set(["list_splat", "dictionary_splat"]);

function spreadArguments(call: PyNode, facts: Database): EffectArg | undefined {
  if (
    children(field(call, "arguments")).some((one) => SPLAT_TYPES.has(one.type))
  ) {
    return undefined;
  }
  const written = callArguments(call);
  const items: EffectArg[] = [];
  const fields: Record<string, EffectArg> = {};
  for (const one of written) {
    if (one.kind === "positional") {
      items.push(argOf(one.node, facts));
      continue;
    }
    fields[one.name] = argOf(one.node, facts);
  }
  return pairOf(
    items.length === 0 ? undefined : { kind: "array", items },
    Object.keys(fields).length === 0 ? undefined : { kind: "object", fields },
  );
}

function packedArguments(
  call: PyNode,
  packed: Extract<PyTaskArguments, { type: "packed" }>,
  facts: Database,
): EffectArg {
  const written = callArguments(call);
  const args = argumentAt(written, packed.args);
  const kwargs = argumentAt(written, packed.kwargs);
  return pairOf(
    args === null ? undefined : sequenceOf(args, facts),
    kwargs === null ? undefined : mappingOf(kwargs, facts),
  );
}

function pairOf(
  positional: EffectArg | undefined,
  keywords: EffectArg | undefined,
): EffectArg {
  if (positional !== undefined && keywords !== undefined) {
    return { kind: "array", items: [positional, keywords] };
  }
  return positional ?? keywords ?? { kind: "array", items: [] };
}

const SEQUENCE_TYPES = new Set(["tuple", "list"]);

/** A tuple or list written out, item by item, and anything else as the argument reads. */
function sequenceOf(node: PyNode, facts: Database): EffectArg {
  const items = children(node);
  if (
    !SEQUENCE_TYPES.has(node.type) ||
    items.some((item) => item.type === "list_splat")
  ) {
    return argOf(node, facts);
  }
  return { kind: "array", items: items.map((item) => argOf(item, facts)) };
}

/** A dictionary written out with string keys, field by field, and anything else as the argument reads. */
function mappingOf(node: PyNode, facts: Database): EffectArg {
  if (node.type !== "dictionary") {
    return argOf(node, facts);
  }
  const fields: Record<string, EffectArg> = {};
  for (const pair of children(node)) {
    const key = pair.type === "pair" ? field(pair, "key") : null;
    const value = pair.type === "pair" ? field(pair, "value") : null;
    const name = key === null ? null : stringValueOf(key, facts);
    if (name === null || value === null) {
      return argOf(node, facts);
    }
    fields[name] = argOf(value, facts);
  }
  return { kind: "object", fields };
}
