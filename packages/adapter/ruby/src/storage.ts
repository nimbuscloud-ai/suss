// storage.ts: which calls in a body talk to the database, for Ruby. A pack
// says which base class the library gives a model, and a call on a class that
// reaches that base is a database call. The README says why ancestry.

import { storageRelationalBinding } from "@suss/ir-core";

import { field } from "./ast.js";
import { nodeId } from "./facts/values.js";

import type { Effect } from "@suss/behavioral-ir";
import type { Database } from "@suss/datalog";
import type { RbStoragePattern } from "./pack.js";
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
  readonly filePath: string;
  readonly patterns: readonly RbStoragePattern[];
}

/**
 * Whether a class reaches one of the named base classes, following what each
 * one extends. A base the project declares is followed through; the one the
 * library gives is matched by the name it is written as, since it has no node
 * in the run to point at.
 */
function reachesBase(
  facts: Database,
  classKey: string,
  bases: readonly string[],
  seen: Set<string> = new Set(),
): boolean {
  if (seen.has(classKey)) {
    return false;
  }
  seen.add(classKey);

  const named = facts
    .facts("extendsNamed")
    .filter((row) => String(row[0]) === classKey)
    .map((row) => String(row[1]));
  if (named.some((name) => bases.includes(name))) {
    return true;
  }

  return facts
    .facts("extends")
    .filter((row) => String(row[0]) === classKey)
    .flatMap((row) =>
      facts
        .facts("binds")
        .filter((bound) => String(bound[0]) === String(row[1]))
        .map((bound) => String(bound[1])),
    )
    .some((next) => reachesBase(facts, next, bases, seen));
}

/** The class a constant refers to, when one thing in the run declares it. */
function classBehind(
  facts: Database,
  filePath: string,
  constant: RbNode,
): string | undefined {
  const key =
    constant.type === "constant"
      ? `${filePath}#${constant.text}`
      : nodeId(filePath, constant);
  const bound = facts
    .facts("binds")
    .filter((row) => String(row[0]) === key)
    .map((row) => String(row[1]));
  return bound.length === 1 ? bound[0] : undefined;
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

/**
 * The database work a body does, one effect per chain. A chain is one thing
 * the code does, so `Order.where(id: 1).first` counts once.
 */
export function storageEffects(
  calls: readonly RbNode[],
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
    const constant = rootConstant(call);
    if (constant === null) {
      continue;
    }
    const classKey = classBehind(options.facts, options.filePath, constant);
    if (classKey === undefined) {
      continue;
    }
    const pattern = options.patterns.find((candidate) =>
      reachesBase(options.facts, classKey, candidate.baseClasses),
    );
    if (pattern === undefined) {
      continue;
    }

    const operation = methodOf(call);
    const picked = selectorOf(call);
    effects.push({
      type: "interaction",
      binding: storageRelationalBinding({
        recognition: "ruby-storage",
        storageSystem: pattern.storageSystem,
        scope: pattern.baseClasses[0] ?? "",
        table: constant.text,
      }),
      callee: call.text,
      interaction: {
        class: "storage-access",
        kind: pattern.writes.includes(operation) ? "write" : "read",
        fields: [],
        operation,
        ...(picked.length > 0 ? { selector: picked } : {}),
      },
    });
  }
  return effects;
}
