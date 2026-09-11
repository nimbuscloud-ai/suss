/**
 * storage.ts: which calls in a body talk to the database, for Ruby.
 *
 * One rule covers both ways a call is written. It is database work when the
 * pack lists its method as a read or a write, the class behind its receiver
 * reaches a base class the pack lists, and the project does not declare that
 * method itself. Every other call is one for the reach walk to follow, so a
 * constructor, a transaction and a project method on a model all say nothing
 * here. The README says why ancestry.
 *
 * The class behind the receiver comes from the constant bindings for a chain
 * written from a constant and from the resolution rules otherwise. A loader
 * pattern adds calls given the model as an argument, tested the same way.
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

type StorageKind = "read" | "write";

/** The calls a chain is made of, the last one first and the one it starts at last. */
function chainLinks(call: RbNode): RbNode[] {
  const links: RbNode[] = [];
  let current: RbNode | null = call;
  while (current !== null && current.type === "call") {
    links.push(current);
    current = receiverOf(current);
  }
  return links;
}

/** What the library does with this method, as the pattern states it. */
function kindOfCall(
  pattern: RbStoragePattern,
  method: string,
): StorageKind | undefined {
  if (pattern.writes.includes(method)) {
    return "write";
  }
  if (pattern.reads.includes(method)) {
    return "read";
  }
  return undefined;
}

/** Whether any pattern in the run says its library defines this method. */
function someLibraryDefines(
  options: RbStorageOptions,
  method: string,
): boolean {
  return options.patterns.some(
    (pattern) => kindOfCall(pattern, method) !== undefined,
  );
}

function argumentsOf(call: RbNode): RbNode[] {
  const args = field(call, "arguments");
  return args === null ? [] : children(args);
}

/** Whether this argument was written as keywords, either bare or inside braces. */
function isKeywordArgument(argument: RbNode): boolean {
  return argument.type === "pair" || argument.type === "hash";
}

/** The name a keyword or a symbol is written under, without the `:` either side of it. */
function bareName(node: RbNode): string {
  return node.text.replace(/^:/, "").replace(/:$/, "");
}

/** The keyword pairs one argument is made of, whether it was written bare or inside braces. */
function pairsIn(argument: RbNode): RbNode[] {
  if (argument.type === "pair") {
    return [argument];
  }
  if (argument.type === "hash") {
    return children(argument).filter((child) => child.type === "pair");
  }
  return [];
}

/** The keys a call was given as keywords, `id` in both `find_by(id: 1)` and `find_by({ id: 1 })`. */
function keywordKeys(call: RbNode): string[] {
  const keys: string[] = [];
  for (const argument of argumentsOf(call)) {
    for (const pair of pairsIn(argument)) {
      const key = field(pair, "key");
      if (key !== null) {
        keys.push(bareName(key));
      }
    }
  }
  return keys;
}

/** Whether the call was given something other than keywords, the `1` in `find(1)`. */
function hasPositionalArgument(call: RbNode): boolean {
  return argumentsOf(call).some((argument) => !isKeywordArgument(argument));
}

/** The columns a read asks for by name, `name` and `email` in `pluck(:name, :email)`. */
function columnsAskedFor(call: RbNode, pattern: RbStoragePattern): string[] {
  if (!(pattern.columnArguments ?? []).includes(methodOf(call))) {
    return [];
  }
  return argumentsOf(call)
    .filter((argument) => argument.type === "simple_symbol")
    .map(bareName);
}

/** The primary key, where this call is a lookup by it and was given one. */
function primaryKeySelector(call: RbNode, pattern: RbStoragePattern): string[] {
  const byPrimaryKey = pattern.byPrimaryKey;
  if (byPrimaryKey === undefined) {
    return [];
  }
  const picks =
    byPrimaryKey.methods.includes(methodOf(call)) &&
    hasPositionalArgument(call);
  return picks ? [byPrimaryKey.column] : [];
}

/**
 * What the chain was given to pick rows by: the keywords of every read
 * along it, and the primary key where a lookup by it was given one
 * positionally.
 */
function selectorOf(call: RbNode, pattern: RbStoragePattern): string[] {
  const picked: string[] = [];
  for (const link of chainLinks(call)) {
    picked.push(...primaryKeySelector(link, pattern));
    if (pattern.reads.includes(methodOf(link))) {
      picked.push(...keywordKeys(link));
    }
  }
  return [...new Set(picked)];
}

/**
 * The columns a call states. A write states them as the data it was given,
 * and a read only where it asks for columns by name. An argument written as
 * a variable states none, and saying nothing is the answer rather than a
 * reason to guess.
 */
function fieldsOf(
  call: RbNode,
  pattern: RbStoragePattern,
  kind: StorageKind,
): string[] {
  if (kind === "write") {
    return [...new Set(keywordKeys(call))];
  }
  return [
    ...new Set(
      chainLinks(call).flatMap((link) => columnsAskedFor(link, pattern)),
    ),
  ];
}

function storageEffect(
  call: RbNode,
  container: string,
  pattern: RbStoragePattern,
  kind: StorageKind,
  selector: string[],
  fields: string[],
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
      fields,
      operation,
      ...(selector.length > 0 ? { selector } : {}),
    },
  };
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

/** A class a call was made on, and the name to report the work under. */
interface CallReceiver {
  readonly classKey: string;
  readonly container: string;
}

/** The class a constant refers to, reported under the constant as written. */
function constantReceiver(
  constant: RbNode,
  file: string,
  facts: Database,
): CallReceiver | undefined {
  const classKey = classBehind(facts, file, constant);
  return classKey === undefined
    ? undefined
    : { classKey, container: constantName(constant) };
}

/** The class the rules settle a receiver on, reported under the name it is declared as. */
function settledReceiver(
  receiver: RbNode,
  file: string,
  facts: Database,
  enclosing: RbNode | null,
): CallReceiver | undefined {
  const classKey = classSettledOn(facts, readKey(file, receiver, enclosing));
  if (classKey === undefined) {
    return undefined;
  }
  const container = declaredName(facts, classKey);
  return container === undefined ? undefined : { classKey, container };
}

/**
 * The class a chain was called on. A chain written from a constant is
 * settled by the bindings for that name, and any other receiver goes to
 * the rules.
 */
function receiverClass(
  call: RbNode,
  file: string,
  options: RbStorageOptions,
  enclosing: RbNode | null,
): CallReceiver | undefined {
  const constant = rootConstant(call);
  if (constant !== null) {
    return constantReceiver(constant, file, options.facts);
  }
  const receiver = receiverOf(call);
  if (receiver === null) {
    return undefined;
  }
  return settledReceiver(receiver, file, options.facts, enclosing);
}

/**
 * The database work one chain does, whether it was written from the model
 * itself or from a record in hand. A method the project declares says
 * nothing here: the reach walk steps into that body, which reports the
 * work it does, and recording it here as well would count it twice.
 */
function modelCallEffects(
  call: RbNode,
  file: string,
  options: RbStorageOptions,
  enclosing: RbNode | null,
): Effect[] {
  const method = methodOf(call);
  if (!someLibraryDefines(options, method)) {
    return [];
  }
  const target = receiverClass(call, file, options, enclosing);
  if (target === undefined) {
    return [];
  }

  for (const pattern of options.patterns) {
    const kind = kindOfCall(pattern, method);
    if (
      kind === undefined ||
      !reachesBase(options.facts, target.classKey, pattern.baseClasses)
    ) {
      continue;
    }
    if (projectDeclares(options.facts, target.classKey, method)) {
      return [];
    }
    return [
      storageEffect(
        call,
        target.container,
        pattern,
        kind,
        selectorOf(call, pattern),
        fieldsOf(call, pattern, kind),
      ),
    ];
  }
  return [];
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
          storageEffect(call, constantName(argument), pattern, "read", [], []),
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
  const onModel = modelCallEffects(call, file, options, enclosing);
  return onModel.length > 0 ? onModel : loaderCallEffects(call, file, options);
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
  const keys: string[] = [];
  for (const call of chains) {
    const receiver = receiverOf(call);
    if (
      receiver !== null &&
      rootConstant(call) === null &&
      someLibraryDefines(options, methodOf(call))
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
