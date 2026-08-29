// storage.ts: which calls in a body talk to the database, for Ruby. A pack
// says which base class the library gives a model, and a call on a class that
// reaches that base is a database call. The README says why ancestry.

import { deriveOnDemand, evaluate } from "@suss/datalog";
import { storageBinding } from "@suss/ir-core";
import {
  ANSWER_RELATIONS,
  RESOLUTION_QUESTIONS,
  RESOLUTION_RULES,
} from "@suss/resolution";

import { field } from "./ast.js";

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
  readonly patterns: readonly RbStoragePattern[];
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
 * The class a constant refers to, when every mention of that name in the run
 * settles on one class. Two classes answering to it would make picking one a
 * guess, so nothing is said, the same caution the constant bindings apply.
 */
function classBehind(facts: Database, constant: RbNode): string | undefined {
  const wanted = `#${constant.text}`;
  const bound = new Set(
    facts
      .facts("binds")
      .filter((row) => String(row[0]).endsWith(wanted))
      .map((row) => String(row[1])),
  );
  return bound.size === 1 ? [...bound][0] : undefined;
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
    const classKey = classBehind(options.facts, constant);
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
      binding: storageBinding({
        recognition: "ruby-storage",
        storageSystem: pattern.storageSystem,
        scope: pattern.baseClasses[0] ?? "",
        container: constant.text,
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
