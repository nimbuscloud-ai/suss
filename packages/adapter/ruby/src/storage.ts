/**
 * storage.ts: which calls in a body talk to the database, for Ruby.
 *
 * A pack says which base class the library gives a model, and a call on a
 * class that reaches that base is a database call. The README says why
 * ancestry. A loader pattern from another pack adds calls that are given
 * the model as an argument instead, and those go through the same test.
 */

import { deriveOnDemand, evaluate } from "@suss/datalog";
import { storageBinding } from "@suss/ir-core";
import {
  ANSWER_RELATIONS,
  RESOLUTION_QUESTIONS,
  RESOLUTION_RULES,
} from "@suss/resolution";

import { field } from "./ast.js";
import { nodeId } from "./facts/values.js";
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
 * The rules rewritten so ancestry is derived only for the classes asked
 * about. Built once, since the rewrite does not depend on the facts.
 */
const ANCESTRY_PROGRAM = deriveOnDemand(
  [...RESOLUTION_RULES, ...RESOLUTION_QUESTIONS],
  ANSWER_RELATIONS,
);

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
  facts.add("wantedAncestry", [classKey]);
  evaluate(facts, ANCESTRY_PROGRAM.rules);
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
  model: RbNode,
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
      container: constantName(model),
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
  return [storageEffect(call, constant, pattern, kind, selectorOf(call))];
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
        effects.push(storageEffect(call, argument, pattern, "read", []));
      }
    }
  }
  return effects;
}

function effectsOfCall(
  call: RbNode,
  file: string,
  options: RbStorageOptions,
): Effect[] {
  const onModel = modelCallEffects(call, file, options);
  return onModel.length > 0 ? onModel : loaderCallEffects(call, file, options);
}

/** Whether the recognizer records this call as database work, so a walk need not report it as a gap. */
export function storageClaims(
  call: RbNode,
  file: string,
  options: RbStorageOptions,
): boolean {
  return (
    options.patterns.length > 0 && effectsOfCall(call, file, options).length > 0
  );
}

/**
 * The database work a body does, one effect per chain. A chain is one thing
 * the code does, so `Order.where(id: 1).first` counts once. `file` is the
 * absolute path the calls were read from, which the constant bindings key on.
 */
export function storageEffects(
  calls: readonly RbNode[],
  file: string,
  options: RbStorageOptions,
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

  const effects: Effect[] = [];
  for (const call of calls) {
    if (partOfOne.has(call.id)) {
      continue;
    }
    effects.push(...effectsOfCall(call, file, options));
  }
  return effects;
}
