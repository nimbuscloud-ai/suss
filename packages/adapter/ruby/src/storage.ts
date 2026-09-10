/**
 * storage.ts: which calls in a body talk to the database, for Ruby.
 *
 * A pack says which base class the library gives a model, and a call on a
 * class that reaches that base is a database call. The README says why
 * ancestry. A loader pattern from another pack adds calls that are given
 * the model as an argument instead, and those go through the same test.
 *
 * A write is also recorded when the receiver is not written as a
 * constant and the rules settle it on such a class, which is how
 * `@account.save` after a `before_action` finder counts.
 */

import { storageBinding } from "@suss/ir-core";
import { askResolution } from "@suss/resolution";

import { field } from "./ast.js";
import { RUBY_PROGRAM } from "./facts/resolve.js";
import { nodeId, readKey } from "./facts/values.js";
import { compoundName } from "./scope.js";

import type { Effect } from "@suss/behavioral-ir";
import type { Database } from "@suss/datalog";
import type { RbLoaderPattern, RbStoragePattern } from "./pack.js";
import type { RbNode } from "./parser.js";

function children(node: RbNode): RbNode[] {
  return node.namedChildren.filter((child): child is RbNode => child !== null);
}

/** The receiver a call is written against. */
function receiverOf(node: RbNode): RbNode | null {
  return node.type === "call" ? field(node, "receiver") : null;
}

/** The method a call says, `where` in `Order.where(id: 1)`. */
function methodOf(node: RbNode): string {
  return field(node, "method")?.text ?? "";
}

/** The constant a chain of receivers starts at, `Order` in `Order.where(x).first`. */
function rootConstant(node: RbNode): RbNode | null {
  const receiver = receiverOf(node);
  if (receiver === null) {
    return null;
  }
  if (receiver.type === "constant" || receiver.type === "scope_resolution") {
    return receiver;
  }
  return rootConstant(receiver);
}

export interface RbStorageOptions {
  readonly facts: Database;
  readonly patterns: readonly RbStoragePattern[];
  readonly loaders?: readonly RbLoaderPattern[];
}

function isConstant(node: RbNode): boolean {
  return node.type === "constant" || node.type === "scope_resolution";
}

/** The name a constant is written as, without the `::` that pins `::Order` to the top level. */
function constantName(constant: RbNode): string {
  return constant.type === "constant" ? constant.text : compoundName(constant);
}

/**
 * Whether a class reaches one of the named base classes. The shared
 * ancestry rules follow what each one extends through the binding
 * behind it; a base the library gives is matched by the name it is
 * written as, since it has no node in the run to point at.
 */
function reachesBase(
  facts: Database,
  classKey: string,
  bases: readonly string[],
): boolean {
  askResolution(facts, [classKey], "wantedAncestry", RUBY_PROGRAM);
  return facts
    .lookup("wantedBaseName", 0, classKey)
    .some((row) => bases.includes(String(row[1])));
}

/**
 * The class a constant refers to, by the key the constant bindings gave this
 * reference: a bare name is bound once per file, a compound path once per
 * node. Two classes bound to it would make picking one a guess, so nothing
 * is said, the same caution the constant bindings apply.
 */
function classBehind(
  facts: Database,
  file: string,
  constant: RbNode,
): string | undefined {
  const key =
    constant.type === "constant"
      ? `${file}#${constant.text}`
      : nodeId(file, constant);
  const bound = new Set(
    facts.lookup("binds", 0, key).map((row) => String(row[1])),
  );
  return bound.size === 1 ? [...bound][0] : undefined;
}

/** The pattern whose base class the constant's class reaches, if the constant is a model. */
function modelPattern(
  constant: RbNode,
  file: string,
  options: RbStorageOptions,
): RbStoragePattern | undefined {
  const classKey = classBehind(options.facts, file, constant);
  if (classKey === undefined) {
    return undefined;
  }
  return options.patterns.find((candidate) =>
    reachesBase(options.facts, classKey, candidate.baseClasses),
  );
}

/** What a chain was given to pick rows by, `id` in `where(id: 1)`. */
function selectorOf(node: RbNode): string[] {
  const picked: string[] = [];
  const walk = (current: RbNode): void => {
    const args = field(current, "arguments");
    for (const argument of args === null ? [] : children(args)) {
      if (argument.type !== "pair") {
        continue;
      }
      const key = field(argument, "key");
      if (key !== null) {
        picked.push(key.text.replace(/^:/, "").replace(/:$/, ""));
      }
    }
    const receiver = receiverOf(current);
    if (receiver !== null) {
      walk(receiver);
    }
  };
  walk(node);
  return [...new Set(picked)];
}

function storageEffect(
  call: RbNode,
  container: string,
  pattern: RbStoragePattern,
  kind: "read" | "write",
  selector: string[],
): Effect {
  const operation = methodOf(call);
  return {
    type: "interaction",
    binding: storageBinding({
      recognition: "ruby-storage",
      storageSystem: pattern.storageSystem,
      scope: "default",
      container,
    }),
    callee: call.text,
    interaction: {
      class: "storage-access",
      kind,
      fields: [],
      operation,
      ...(selector.length > 0 ? { selector } : {}),
    },
  };
}

/** The effect of a call on a model, `Order.where(id: 1).first`. */
function modelCallEffects(
  call: RbNode,
  file: string,
  options: RbStorageOptions,
): Effect[] {
  const constant = rootConstant(call);
  if (constant === null) {
    return [];
  }
  const pattern = modelPattern(constant, file, options);
  if (pattern === undefined) {
    return [];
  }
  const kind = pattern.writes.includes(methodOf(call)) ? "write" : "read";
  return [
    storageEffect(
      call,
      constantName(constant),
      pattern,
      kind,
      selectorOf(call),
    ),
  ];
}

/** Every method a pattern in this run counts as changing what is stored. */
function writeMethods(patterns: readonly RbStoragePattern[]): Set<string> {
  return new Set(patterns.flatMap((pattern) => pattern.writes));
}

/**
 * The class the rules settle a receiver on, when they settle on exactly
 * one. Two would make picking one a guess, the same caution the constant
 * bindings apply.
 */
function classSettledOn(facts: Database, key: string): string | undefined {
  askResolution(facts, [key], "wanted", RUBY_PROGRAM);
  const objects = new Set(
    facts.lookup("wantedObjectOf", 0, key).map((row) => String(row[1])),
  );
  return objects.size === 1 ? [...objects][0] : undefined;
}

/**
 * The name a class is declared under, which is what a constant receiver
 * would have been written as. A class reopened in several files binds to
 * one of them, so one name comes back.
 */
function declaredName(facts: Database, classKey: string): string | undefined {
  const names = new Set(
    facts.lookup("rbConstantName", 0, classKey).map((row) => String(row[1])),
  );
  return names.size === 1 ? [...names][0] : undefined;
}

/**
 * Whether the project writes this method itself somewhere in the class's
 * ancestry. The reach walk steps into that body, and the body reports
 * whatever database work it does, so recording a write here as well
 * would count the same work twice. `reachesBase` has already asked
 * `wantedAncestry` about the class, which is what derives this.
 */
function projectDeclares(
  facts: Database,
  classKey: string,
  method: string,
): boolean {
  return facts
    .lookup("wantedDeclaredName", 0, classKey)
    .some((row) => String(row[1]) === method);
}

/**
 * The write a call makes on a receiver written as something other than a
 * constant. Only a write, because a read on an instance is as likely an
 * attribute read or a project method the walk follows. No selector: the
 * record is already in hand, so the keywords are the data being written
 * rather than a `where`.
 */
function instanceWriteEffects(
  call: RbNode,
  file: string,
  options: RbStorageOptions,
  enclosing: RbNode | null,
): Effect[] {
  const receiver = receiverOf(call);
  const method = methodOf(call);
  if (receiver === null || !writeMethods(options.patterns).has(method)) {
    return [];
  }
  const classKey = classSettledOn(
    options.facts,
    readKey(file, receiver, enclosing),
  );
  if (classKey === undefined) {
    return [];
  }
  const pattern = options.patterns.find(
    (candidate) =>
      candidate.writes.includes(method) &&
      reachesBase(options.facts, classKey, candidate.baseClasses),
  );
  if (
    pattern === undefined ||
    projectDeclares(options.facts, classKey, method)
  ) {
    return [];
  }
  const container = declaredName(options.facts, classKey);
  return container === undefined
    ? []
    : [storageEffect(call, container, pattern, "write", [])];
}

/** Whether a node is the loader itself, the receiverless `dataloader`. */
function isLoader(node: RbNode | null, loader: RbLoaderPattern): boolean {
  if (node === null) {
    return false;
  }
  if (node.type === "identifier") {
    return node.text === loader.loader;
  }
  return (
    node.type === "call" &&
    receiverOf(node) === null &&
    methodOf(node) === loader.loader
  );
}

/**
 * The call that was given the model, for a read through a loader: the
 * `with` behind `dataloader.with(Source, ::User).load(id)`, or the
 * shortcut itself for `dataload_record(::User, id)`. Null otherwise.
 */
function loaderPick(call: RbNode, loader: RbLoaderPattern): RbNode | null {
  const method = methodOf(call);
  const receiver = receiverOf(call);
  if (receiver === null) {
    return loader.shortcuts.includes(method) ? call : null;
  }
  if (!loader.reads.includes(method) || receiver.type !== "call") {
    return null;
  }
  const picks =
    methodOf(receiver) === loader.pick &&
    isLoader(receiverOf(receiver), loader);
  return picks ? receiver : null;
}

/** One read per model a loader call is given. The source class it is also given reaches no model base, so it drops out here. */
function loaderCallEffects(
  call: RbNode,
  file: string,
  options: RbStorageOptions,
): Effect[] {
  const effects: Effect[] = [];
  for (const loader of options.loaders ?? []) {
    const pick = loaderPick(call, loader);
    if (pick === null) {
      continue;
    }
    const args = field(pick, "arguments");
    for (const argument of args === null ? [] : children(args)) {
      if (!isConstant(argument)) {
        continue;
      }
      const pattern = modelPattern(argument, file, options);
      if (pattern !== undefined) {
        effects.push(
          storageEffect(call, constantName(argument), pattern, "read", []),
        );
      }
    }
  }
  return effects;
}

function effectsOfCall(
  call: RbNode,
  file: string,
  options: RbStorageOptions,
  enclosing: RbNode | null,
): Effect[] {
  const onModel = modelCallEffects(call, file, options);
  if (onModel.length > 0) {
    return onModel;
  }
  // A chain starting at a constant has already been settled by name, so
  // asking the rules about its receiver would settle nothing new.
  const onInstance =
    rootConstant(call) === null
      ? instanceWriteEffects(call, file, options, enclosing)
      : [];
  return onInstance.length > 0
    ? onInstance
    : loaderCallEffects(call, file, options);
}

/**
 * Whether the recognizer records this call as database work, so a walk
 * need not report it as a gap. `enclosing` is the method the call is
 * written in, which is what tells one body's locals from the next.
 */
export function storageClaims(
  call: RbNode,
  file: string,
  options: RbStorageOptions,
  enclosing: RbNode | null = null,
): boolean {
  return (
    options.patterns.length > 0 &&
    effectsOfCall(call, file, options, enclosing).length > 0
  );
}

/** The receivers this body asks the rules about, so one evaluation settles them all. */
function receiverKeysToAsk(
  chains: readonly RbNode[],
  file: string,
  options: RbStorageOptions,
  enclosing: RbNode | null,
): string[] {
  const writes = writeMethods(options.patterns);
  const keys: string[] = [];
  for (const call of chains) {
    const receiver = receiverOf(call);
    if (
      receiver !== null &&
      writes.has(methodOf(call)) &&
      rootConstant(call) === null
    ) {
      keys.push(readKey(file, receiver, enclosing));
    }
  }
  return keys;
}

/**
 * The database work a body does, one effect per chain. A chain is one thing
 * the code does, so `Order.where(id: 1).first` counts once. `file` is the
 * absolute path the calls were read from, which the constant bindings key on.
 * `enclosing` is the method the calls were read from, or null outside one.
 */
export function storageEffects(
  calls: readonly RbNode[],
  file: string,
  options: RbStorageOptions,
  enclosing: RbNode | null = null,
): Effect[] {
  if (options.patterns.length === 0) {
    return [];
  }

  const partOfOne = new Set<number>();
  for (const call of calls) {
    const receiver = receiverOf(call);
    if (receiver !== null) {
      partOfOne.add(receiver.id);
    }
  }

  const chains = calls.filter((call) => !partOfOne.has(call.id));
  askResolution(
    options.facts,
    receiverKeysToAsk(chains, file, options, enclosing),
    "wanted",
    RUBY_PROGRAM,
  );

  const effects: Effect[] = [];
  for (const call of chains) {
    effects.push(...effectsOfCall(call, file, options, enclosing));
  }
  return effects;
}
