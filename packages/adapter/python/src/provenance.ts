/**
 * Where a value in a Python body came from, written as the value
 * references a guard uses.
 *
 * The walk is the shared one in `@suss/resolution`, and the extractor's
 * `sourceRefsOf` turns where it ended into references. What an input is
 * in Python is said here: a path off one of the unit's own parameters,
 * or off an object a pack says the library puts the request on, such as
 * Flask's `request`.
 */

import { sourceRefsOf } from "@suss/extractor";
import { constantOf, literalOf } from "@suss/values";

import { children, field, NodeMap, stripDecorators } from "./ast.js";
import { askSourceQuestions, sourcesOf } from "./facts/resolve.js";
import { operandsOf } from "./paths/predicates.js";
import { bodyStorage } from "./storage.js";
import {
  evaluatedValue,
  nodeOfResolutionKey,
  resolutionKeyOf,
} from "./values/evaluator.js";

import type { ValueRef } from "@suss/behavioral-ir";
import type { Database } from "@suss/datalog";
import type { RawProvenance, SourceSpelling } from "@suss/extractor";
import type { SourceLeaf, SourceQuestion } from "@suss/resolution";
import type { RequestObject } from "./pack.js";
import type { PyNode } from "./parser.js";
import type { EffectSlot, StorageLookup } from "./storage.js";

/** What a place the walk ended at means, for one unit. */
export interface SourceContext {
  readonly facts: Database;
  /** The function whose parameters are the unit's inputs. */
  readonly unit: PyNode;
}

/** The objects the run's packs say a library puts the request on, per database. */
const requestObjectsByDb = new WeakMap<Database, readonly RequestObject[]>();

/** Say which objects the run's packs put the request on, for reads through `db`. */
export function bindRequestObjects(
  db: Database,
  objects: readonly RequestObject[],
): void {
  requestObjectsByDb.set(db, objects);
}

/**
 * The input each operand of a unit's conditions reads, by node id, for
 * the operands whose value came from exactly one input. Asked as one
 * question, so a body pays one evaluation for all its guards.
 */
export function guardInputs(
  operands: readonly PyNode[],
  context: SourceContext,
): Map<number, ValueRef> {
  const found = new Map<number, ValueRef>();
  const sources = valueSources(operands, context, "wantedInputRead");
  for (const [operand, refs] of sources) {
    const [only] = refs;
    if (refs.length === 1 && only?.type === "input") {
      found.set(operand.id, only);
    }
  }
  return found;
}

/**
 * Asks both source questions for these functions at once, so each body's
 * own questions find their keys already asked. DESIGN.md says why a
 * caller passes only the functions that become units.
 */
export function askFileSources(
  functions: readonly PyNode[],
  facts: Database,
  lookup: StorageLookup | undefined,
): void {
  const operands = functions.flatMap(guardSubjectsIn);
  const values =
    lookup === undefined
      ? []
      : functions.flatMap((fn) =>
          bodyStorage(fn, lookup).slots.map((one) => one.value),
        );
  askSourceQuestions(facts, keysOf(operands, facts), "wantedInputRead");
  askSourceQuestions(facts, keysOf(values, facts), "wantedSource");
}

/** The statements whose `condition` a body's paths branch on. */
const BRANCHING = new Set(["if_statement", "elif_clause", "while_statement"]);

/** The subjects of every branch condition written in a function, nested ones included. */
function guardSubjectsIn(fn: PyNode): PyNode[] {
  const found: PyNode[] = [];
  const visit = (node: PyNode): void => {
    const condition = BRANCHING.has(node.type)
      ? field(node, "condition")
      : null;
    if (condition !== null) {
      found.push(...conditionSubjects(condition));
    }
    for (const child of children(node)) {
      visit(child);
    }
  };
  visit(fn);
  return found;
}

/** `a and not b` branches on `a` and on `b`, each on its own path. */
function conditionSubjects(condition: PyNode): PyNode[] {
  if (condition.type !== "boolean_operator") {
    return operandsOf(condition);
  }
  const left = field(condition, "left");
  const right = field(condition, "right");
  return [
    ...(left === null ? [] : conditionSubjects(left)),
    ...(right === null ? [] : conditionSubjects(right)),
  ];
}

function keysOf(nodes: readonly PyNode[], facts: Database): string[] {
  const keys = new Set<string>();
  for (const node of nodes) {
    const key = resolutionKeyOf(node, facts);
    if (key !== null) {
      keys.add(key);
    }
  }
  return [...keys];
}

/** Where each slot's value came from, as the entries a branch records. */
export function slotProvenance(
  slots: readonly EffectSlot[],
  context: SourceContext,
): RawProvenance[] {
  const found = valueSources(
    slots.map((one) => one.value),
    context,
  );
  return slots.map((one) => ({
    effect: one.effect,
    slot: one.slot,
    name: one.name,
    from: found.get(one.value) ?? [],
  }));
}

/** Where each value came from, asked as one question. */
export function valueSources(
  values: readonly PyNode[],
  context: SourceContext,
  question: SourceQuestion = "wantedSource",
): NodeMap<ValueRef[]> {
  const { facts } = context;
  const keys = new NodeMap<string>();
  const asked = new Set<string>();
  for (const value of values) {
    const key = resolutionKeyOf(value, facts);
    if (key !== null) {
      keys.set(value, key);
      asked.add(key);
    }
  }
  const leaves = sourcesOf(facts, [...asked], question);
  const spelling = spellingFor(context);
  const found = new NodeMap<ValueRef[]>();
  for (const [value, key] of keys) {
    found.set(value, sourceRefsOf(leaves.get(key) ?? [], spelling));
  }
  return found;
}

function spellingFor(context: SourceContext): SourceSpelling<SourceLeaf> {
  const { facts } = context;
  const unitKey = resolutionKeyOf(
    stripDecorators(context.unit).definition,
    facts,
  );
  const requestObjects = requestObjectsByDb.get(facts) ?? [];
  return {
    inputOf: (leaf) => inputOf(leaf, unitKey, requestObjects),
    literalAt: (key) => literalAt(key, facts),
    textAt: (key) => nodeOfResolutionKey(key, facts)?.text ?? null,
  };
}

/**
 * A path off the unit's own parameter, or off an object a pack says the
 * library puts the request on. A parameter's key is the function's key,
 * a `#`, and the parameter's name.
 */
function inputOf(
  leaf: SourceLeaf,
  unitKey: string | null,
  requestObjects: readonly RequestObject[],
): ValueRef | null {
  const { end } = leaf;
  if (end.is === "parameter" && end.of === unitKey) {
    const name = leaf.key.slice(leaf.key.lastIndexOf("#") + 1);
    return { type: "input", inputRef: name, path: leaf.path };
  }
  if (end.is !== "import") {
    return null;
  }
  const isRequest = requestObjects.some(
    (one) => one.module === end.module && one.name === end.name,
  );
  return isRequest
    ? { type: "input", inputRef: end.name, path: leaf.path }
    : null;
}

/** The literal a written value is, or undefined when it is not one. */
function literalAt(
  key: string,
  facts: Database,
): string | number | boolean | null | undefined {
  const node = nodeOfResolutionKey(key, facts);
  if (node === null) {
    return undefined;
  }
  const value = evaluatedValue(node, facts);
  const constant = constantOf(value);
  return constant !== undefined ? constant : (literalOf(value) ?? undefined);
}
