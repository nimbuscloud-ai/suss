/**
 * Finds the calls in a Ruby body that read or write the database.
 *
 * A call is database work when the pack lists its method as a read or a
 * write, the class behind its receiver reaches a base class the pack
 * lists, and the project does not declare that method itself. A chain
 * counts once, at the outermost call the library defines. Every other
 * call is left to the reach walk.
 *
 * The receiver's class comes from the constant bindings when the chain
 * starts at a constant, and from the resolution rules otherwise. Loader
 * calls and raw SQL calls are reported through here as well.
 */

import { storageBinding } from "@suss/ir-core";
import { askResolution, classMemberName } from "@suss/resolution";

import {
  field,
  hashKeySymbolName,
  readCallArgs,
  stringLiteralValue,
  symbolValue,
} from "./ast.js";
import { classBehind, reachesBase } from "./baseClass.js";
import { RUBY_PROGRAM } from "./facts/resolve.js";
import { readKey } from "./facts/values.js";
import { loaderPick } from "./loaders.js";
import {
  NOWHERE,
  rawSqlEffects,
  statementAt,
  statementEffects,
} from "./rawSql.js";
import { compoundName } from "./scope.js";
import { evaluatedValue, stringValueOf } from "./values/evaluator.js";

import type { Effect } from "@suss/behavioral-ir";
import type { Database } from "@suss/datalog";
import type {
  RbArgumentPlace,
  RbLoaderPattern,
  RbRawSqlPattern,
  RbStoragePattern,
} from "./pack.js";
import type { RbNode } from "./parser.js";

function children(node: RbNode): RbNode[] {
  return node.namedChildren.filter((child): child is RbNode => child !== null);
}

function receiverOf(node: RbNode): RbNode | null {
  return node.type === "call" ? field(node, "receiver") : null;
}

/** The method name of a call, `where` in `Order.where(id: 1)`. */
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
  /** The pack declarations for calls that take SQL the project wrote itself. */
  readonly rawSql?: readonly RbRawSqlPattern[];
}

function isConstant(node: RbNode): boolean {
  return node.type === "constant" || node.type === "scope_resolution";
}

/** The constant's name, without the leading `::` of a top-level reference like `::Order`. */
function constantName(constant: RbNode): string {
  return constant.type === "constant" ? constant.text : compoundName(constant);
}

/** The pattern whose base class the constant's class reaches, or undefined when the constant is not a model. */
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

/** The calls in a chain, from the outermost call to the one the chain starts at. */
function chainLinks(call: RbNode): RbNode[] {
  const links: RbNode[] = [];
  let current: RbNode | null = call;
  while (current !== null && current.type === "call") {
    links.push(current);
    current = receiverOf(current);
  }
  return links;
}

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

/** A library method either runs a statement the project wrote, or reads or writes rows of the model's own container. */
type LibraryCall =
  | { readonly how: "statement"; readonly place: RbArgumentPlace }
  | { readonly how: "rows"; readonly kind: StorageKind };

/** What the pattern declares this method does, or undefined when its library does not define it. */
function libraryCallOf(
  pattern: RbStoragePattern,
  method: string,
): LibraryCall | undefined {
  const place = pattern.statements?.[method];
  if (place !== undefined) {
    return { how: "statement", place };
  }
  const kind = kindOfCall(pattern, method);
  return kind === undefined ? undefined : { how: "rows", kind };
}

/** Whether any pattern in the run declares this method as one its library defines. */
function someLibraryDefines(
  options: RbStorageOptions,
  method: string,
): boolean {
  return options.patterns.some(
    (pattern) => libraryCallOf(pattern, method) !== undefined,
  );
}

function argumentsOf(call: RbNode): RbNode[] {
  const args = field(call, "arguments");
  return args === null ? [] : children(args);
}

/** The keys of the hash an argument evaluates to, or none when it does not evaluate to a hash. */
function recordFieldsOf(argument: RbNode, facts: Database): string[] {
  const value = evaluatedValue(argument, facts);
  return value.kind === "record" ? [...value.fields.keys()] : [];
}

/** The keys a call is passed, `id` in `find_by(id: 1)`, `find_by({ id: 1 })` and `find_by(CONDITIONS)`. */
function keywordKeys(call: RbNode, facts: Database): string[] {
  const keys: string[] = [];
  for (const argument of argumentsOf(call)) {
    if (argument.type !== "pair") {
      keys.push(...recordFieldsOf(argument, facts));
      continue;
    }
    const key = field(argument, "key");
    const name = key === null ? null : keyNameOf(key);
    if (name !== null) {
      keys.push(name);
    }
  }
  return keys;
}

/** A hash key's name, `id` for each of `id:`, `:id =>` and `"id" =>`. */
function keyNameOf(key: RbNode): string | null {
  return hashKeySymbolName(key) ?? symbolValue(key) ?? stringLiteralValue(key);
}

/** Whether the call is passed something other than keys, such as the `1` in `find(1)`. */
function hasPositionalArgument(call: RbNode, facts: Database): boolean {
  return argumentsOf(call).some(
    (argument) =>
      argument.type !== "pair" && recordFieldsOf(argument, facts).length === 0,
  );
}

/** The columns a read asks for by name, `name` and `email` in `pluck(:name, :email)`. */
function columnsAskedFor(
  call: RbNode,
  pattern: RbStoragePattern,
  facts: Database,
): string[] {
  if (!(pattern.columnArguments ?? []).includes(methodOf(call))) {
    return [];
  }
  return argumentsOf(call)
    .map((argument) => stringValueOf(argument, facts))
    .filter((column): column is string => column !== null);
}

/** The primary key column, when this call looks rows up by primary key and is passed one. */
function primaryKeySelector(
  call: RbNode,
  pattern: RbStoragePattern,
  facts: Database,
): string[] {
  const byPrimaryKey = pattern.byPrimaryKey;
  if (byPrimaryKey === undefined) {
    return [];
  }
  const picks =
    byPrimaryKey.methods.includes(methodOf(call)) &&
    hasPositionalArgument(call, facts);
  return picks ? [byPrimaryKey.column] : [];
}

/**
 * What the chain picks rows by: the keys passed to every read along it,
 * plus the primary key when a lookup by primary key is passed one
 * positionally.
 */
function selectorOf(
  call: RbNode,
  pattern: RbStoragePattern,
  facts: Database,
): string[] {
  const picked: string[] = [];
  for (const link of chainLinks(call)) {
    picked.push(...primaryKeySelector(link, pattern, facts));
    if (pattern.reads.includes(methodOf(link))) {
      picked.push(...keywordKeys(link, facts));
    }
  }
  return [...new Set(picked)];
}

/**
 * The columns a call mentions. For a write they are the keys of the data it
 * is passed. For a read they are the columns it asks for by name. An
 * argument written as a variable gives no columns, and the adapter does
 * not guess at them.
 */
function fieldsOf(
  call: RbNode,
  pattern: RbStoragePattern,
  kind: StorageKind,
  facts: Database,
): string[] {
  if (kind === "write") {
    return [...new Set(keywordKeys(call, facts))];
  }
  return [
    ...new Set(
      chainLinks(call).flatMap((link) => columnsAskedFor(link, pattern, facts)),
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
 * one. With two, picking either would be a guess, so the result is
 * undefined, as it is for the constant bindings.
 */
function classSettledOn(facts: Database, key: string): string | undefined {
  askResolution(facts, [key], "wanted", RUBY_PROGRAM);
  const objects = new Set(
    facts.lookup("wantedObjectOf", 0, key).map((row) => String(row[1])),
  );
  return objects.size === 1 ? [...objects][0] : undefined;
}

/**
 * The name a class is declared under, which is how a constant receiver
 * would have written it. A class reopened in several files binds to one
 * of them, so only one name comes back.
 */
function declaredName(facts: Database, classKey: string): string | undefined {
  const names = new Set(
    facts.lookup("rbConstantName", 0, classKey).map((row) => String(row[1])),
  );
  return names.size === 1 ? [...names][0] : undefined;
}

/**
 * Whether the project defines this method somewhere in the class's
 * ancestry, as a class method or an instance method. The reach walk steps
 * into that body and reports its database work, so recording the call
 * here too would count the work twice.
 * `reachesBase` has already asked `wantedAncestry` about the class, which
 * derives the facts this reads.
 */
function projectDeclares(
  facts: Database,
  classKey: string,
  method: string,
): boolean {
  const spellings = new Set([method, classMemberName(method)]);
  return facts
    .lookup("wantedDeclaredName", 0, classKey)
    .some((row) => spellings.has(String(row[1])));
}

/** The class a call was made on, and the container name to report the work under. */
interface CallReceiver {
  readonly classKey: string;
  readonly container: string;
}

/** The class a constant refers to, reported under the constant's name as written. */
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

/** The class the rules settle a receiver on, reported under the name the class is declared with. */
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
 * The class a chain was called on. When the chain starts at a constant,
 * the constant bindings give the class. Any other receiver goes to the
 * rules.
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
 * The call in a chain that does the database work: the outermost one
 * whose method the library defines. Anything after it is a method on the
 * result, which the reach walk follows, so for `Order.find(id)&.summary`
 * this returns the `find`. Null when the library defines none of them.
 */
function libraryCallIn(call: RbNode, options: RbStorageOptions): RbNode | null {
  return (
    chainLinks(call).find((link) =>
      someLibraryDefines(options, methodOf(link)),
    ) ?? null
  );
}

/** The work a statement passed to a model does. The tables come from the statement instead of the model's container, and there can be several. */
function modelStatementEffects(
  call: RbNode,
  place: RbArgumentPlace,
  pattern: RbStoragePattern,
  options: RbStorageOptions,
): Effect[] {
  const args = readCallArgs(field(call, "arguments"));
  return statementEffects(
    call,
    statementAt(args, place, options.facts, pattern.bindPlaceholder),
    NOWHERE,
    { storageSystem: pattern.storageSystem, dialect: pattern.storageSystem },
  );
}

/** A method the library runs by itself when a write happens. */
export interface RunCallback {
  /** The method name the class body registered. The invocation is recorded under it. */
  readonly name: string;
  /** The key of the `def` behind it, the same key the reach walk uses for methods. */
  readonly key: string;
}

/**
 * The callbacks a write on this class runs. The pack declares which
 * events a write method fires and which class-body calls register a
 * callback. The shared rules follow both through the ancestry, so a
 * callback registered on a base class counts for every model below it.
 */
function callbacksRunBy(
  facts: Database,
  classKey: string,
  pattern: RbStoragePattern,
  writeMethod: string,
): RunCallback[] {
  const events = pattern.callbacks?.eventOf[writeMethod] ?? [];
  if (events.length === 0) {
    return [];
  }

  askResolution(facts, [classKey], "wantedAncestry", RUBY_PROGRAM);
  const found = new Map<string, RunCallback>();
  for (const row of facts.lookup("wantedCallbackMethod", 0, classKey)) {
    if (events.includes(String(row[1]))) {
      const key = String(row[3]);
      found.set(key, { name: String(row[2]), key });
    }
  }
  return [...found.values()];
}

/** An invocation of a callback, which the body never calls by name but the walk still follows. */
function callbackEffect(callback: RunCallback): Effect {
  return {
    type: "invocation",
    callee: callback.name,
    args: [],
    async: false,
  };
}

/**
 * The database work one chain does, whether it starts at the model or at
 * a record. A method the project declares on the class gives nothing
 * here, because the reach walk steps into that body and reports its work.
 */
function modelCallEffects(
  call: RbNode,
  file: string,
  options: RbStorageOptions,
  enclosing: RbNode | null,
): Effect[] {
  const worked = libraryCallIn(call, options);
  if (worked === null) {
    return [];
  }
  const method = methodOf(worked);
  const target = receiverClass(worked, file, options, enclosing);
  if (target === undefined) {
    return [];
  }

  for (const pattern of options.patterns) {
    const library = libraryCallOf(pattern, method);
    if (
      library === undefined ||
      !reachesBase(options.facts, target.classKey, pattern.baseClasses)
    ) {
      continue;
    }
    if (projectDeclares(options.facts, target.classKey, method)) {
      return [];
    }
    if (library.how === "statement") {
      return modelStatementEffects(worked, library.place, pattern, options);
    }
    const ran =
      library.kind === "write"
        ? callbacksRunBy(options.facts, target.classKey, pattern, method)
        : [];
    return [
      storageEffect(
        worked,
        target.container,
        pattern,
        library.kind,
        selectorOf(worked, pattern, options.facts),
        fieldsOf(worked, pattern, library.kind, options.facts),
      ),
      ...ran.map(callbackEffect),
    ];
  }
  return [];
}

/**
 * The callbacks a chain's write makes the library run, for the walk to
 * follow. Empty unless the chain is a write the recognizer records on a
 * class whose ancestry registers callbacks.
 */
export function callbacksReached(
  call: RbNode,
  file: string,
  options: RbStorageOptions,
  enclosing: RbNode | null = null,
): RunCallback[] {
  const worked = libraryCallIn(call, options);
  const target =
    worked === null
      ? undefined
      : receiverClass(worked, file, options, enclosing);
  if (worked === null || target === undefined) {
    return [];
  }

  const method = methodOf(worked);
  for (const pattern of options.patterns) {
    if (
      libraryCallOf(pattern, method)?.how !== "rows" ||
      kindOfCall(pattern, method) !== "write" ||
      !reachesBase(options.facts, target.classKey, pattern.baseClasses) ||
      projectDeclares(options.facts, target.classKey, method)
    ) {
      continue;
    }
    return callbacksRunBy(options.facts, target.classKey, pattern, method);
  }
  return [];
}

/** One read per model passed to a loader call. The source class passed with it does not reach a model base, so it is skipped. */
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
  if (onModel.length > 0) {
    return onModel;
  }

  const throughLoader = loaderCallEffects(call, file, options);
  if (throughLoader.length > 0) {
    return throughLoader;
  }

  return rawSqlEffects(call, {
    facts: options.facts,
    patterns: options.rawSql ?? [],
    file,
  });
}

/**
 * Whether the recognizer records this call as database work, so a walk
 * does not need to report it as a gap. `enclosing` is the method the call
 * is written in, which keeps one method's locals apart from another's.
 */
export function storageClaims(
  call: RbNode,
  file: string,
  options: RbStorageOptions,
  enclosing: RbNode | null = null,
): boolean {
  return (
    saysAnything(options) &&
    effectsOfCall(call, file, options, enclosing).length > 0
  );
}

/** Whether any pack in the run declares a storage or raw SQL pattern. */
function saysAnything(options: RbStorageOptions): boolean {
  return options.patterns.length > 0 || (options.rawSql ?? []).length > 0;
}

/** Every receiver in the body to ask the rules about, so one question covers them all. */
function receiverKeysToAsk(
  chains: readonly RbNode[],
  file: string,
  options: RbStorageOptions,
  enclosing: RbNode | null,
): string[] {
  const keys: string[] = [];
  for (const call of chains) {
    // Ask about the receiver of the call the effect is recorded at, so
    // `@status.update(x).present?` asks about `@status`.
    const worked = libraryCallIn(call, options);
    if (worked === null || rootConstant(worked) !== null) {
      continue;
    }
    const receiver = receiverOf(worked);
    if (receiver !== null) {
      keys.push(readKey(file, receiver, enclosing));
    }
  }
  return keys;
}

/**
 * The database work a body does, one effect per chain, so
 * `Order.where(id: 1).first` counts once. `file` is the absolute path the
 * calls were read from, which the constant bindings are keyed on.
 * `enclosing` is the method the calls are in, or null outside one.
 */
export function storageEffects(
  calls: readonly RbNode[],
  file: string,
  options: RbStorageOptions,
  enclosing: RbNode | null = null,
): Effect[] {
  if (!saysAnything(options)) {
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
