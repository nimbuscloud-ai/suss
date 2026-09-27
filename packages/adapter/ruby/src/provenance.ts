/**
 * Where a value in a Ruby body came from, written as the value
 * references a guard uses.
 *
 * The walk is the shared one in `@suss/resolution`, and the extractor's
 * `sourceRefsOf` turns where it ended into references. What an input is
 * in Ruby is said here: a path off one of the method's own parameters,
 * or off a method a pack says an action calls to read the request, such
 * as Rails' `params`.
 */

import { sourceRefsOf } from "@suss/extractor";
import { constantOf, literalOf } from "@suss/values";

import { field, NodeMap } from "./ast.js";
import { sourcesOf } from "./facts/resolve.js";
import {
  evaluatedValue,
  nodeOfResolutionKey,
  resolutionKeyOf,
} from "./values/evaluator.js";

import type { Effect, ValueRef } from "@suss/behavioral-ir";
import type { Database } from "@suss/datalog";
import type { RawProvenance, SourceSpelling } from "@suss/extractor";
import type { SourceLeaf, SourceQuestion } from "@suss/resolution";
import type { RbNode } from "./parser.js";
import type { SlotValue } from "./storage.js";

/** What a place the walk ended at means, for one unit. */
export interface SourceContext {
  readonly facts: Database;
  /** The method whose parameters are the unit's inputs. */
  readonly unit: RbNode;
}

/** The methods the run's packs say an action reads the request through, per database. */
const requestAccessorsByDb = new WeakMap<Database, readonly string[]>();

/** Say which methods the run's packs read the request through, for reads through `db`. */
export function bindRequestAccessors(
  db: Database,
  accessors: readonly string[],
): void {
  requestAccessorsByDb.set(db, accessors);
}

/**
 * The input each operand of a unit's conditions reads, by node id, for
 * the operands whose value came from exactly one input. Asked as one
 * question, so a body pays one evaluation for all its guards.
 */
export function guardInputs(
  operands: readonly RbNode[],
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

/** One slot of one effect, and the value the call passes for it. */
export interface EffectSlot extends SlotValue {
  effect: Effect;
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

/**
 * The entries whose effect a branch has, for each branch. A body's
 * effects go on every branch the same, so each branch keeps the ones it
 * was given.
 */
export function withSlotSources<B extends { extraEffects?: Effect[] }>(
  branches: readonly B[],
  provenance: readonly RawProvenance[] | undefined,
): Array<B & { provenance?: RawProvenance[] }> {
  if (provenance === undefined || provenance.length === 0) {
    return [...branches];
  }
  return branches.map((branch) => {
    const kept = provenance.filter((one) =>
      (branch.extraEffects ?? []).includes(one.effect),
    );
    return kept.length === 0 ? branch : { ...branch, provenance: kept };
  });
}

/** Where each value came from, asked as one question. */
export function valueSources(
  values: readonly RbNode[],
  context: SourceContext,
  question: SourceQuestion = "wantedSource",
): NodeMap<ValueRef[]> {
  const keys = new NodeMap<string>();
  const asked = new Set<string>();
  for (const value of values) {
    const key = resolutionKeyOf(value);
    if (key !== null) {
      keys.set(value, key);
      asked.add(key);
    }
  }
  const leaves = sourcesOf(context.facts, [...asked], question);
  const spelling = spellingFor(context);
  const found = new NodeMap<ValueRef[]>();
  for (const [value, key] of keys) {
    found.set(value, sourceRefsOf(leaves.get(key) ?? [], spelling));
  }
  return found;
}

function spellingFor(context: SourceContext): SourceSpelling<SourceLeaf> {
  const { facts } = context;
  const unitKey = resolutionKeyOf(context.unit);
  const accessors = requestAccessorsByDb.get(facts) ?? [];
  return {
    inputOf: (leaf) => inputOf(leaf, unitKey, facts, accessors),
    literalAt: (key) => literalAt(key, facts),
    textAt: (key) => nodeOfResolutionKey(key, facts)?.text ?? null,
  };
}

/**
 * A path off the unit's own parameter, or off the request a pack says an
 * action reads through a method. A parameter's key is the method's key,
 * a `#`, and the parameter's name.
 */
function inputOf(
  leaf: SourceLeaf,
  unitKey: string | null,
  facts: Database,
  accessors: readonly string[],
): ValueRef | null {
  if (leaf.end.is === "parameter" && leaf.end.of === unitKey) {
    const name = leaf.key.slice(leaf.key.lastIndexOf("#") + 1);
    return { type: "input", inputRef: name, path: leaf.path };
  }
  if (leaf.end.is !== "call") {
    return null;
  }
  const call = nodeOfResolutionKey(leaf.key, facts);
  const read = call === null ? null : accessorRead(call, accessors);
  return read === null
    ? null
    : {
        type: "input",
        inputRef: read.accessor,
        path: [...read.path, ...leaf.path],
      };
}

/**
 * `params`, or `request.headers`: a method called with no arguments,
 * whether on its own or on another such call, down to a method a pack
 * says reads the request. The methods on the way are the path off it.
 */
function accessorRead(
  call: RbNode,
  accessors: readonly string[],
): { accessor: string; path: string[] } | null {
  const path: string[] = [];
  let current: RbNode | null = call;
  while (current !== null) {
    const method = bareMethodOf(current);
    if (method === null) {
      return null;
    }
    const receiver = field(current, "receiver");
    if (receiver === null) {
      return accessors.includes(method) ? { accessor: method, path } : null;
    }
    path.unshift(method);
    current = receiver;
  }
  return null;
}

/** The method a call with no arguments reaches for, or null for anything else. */
function bareMethodOf(node: RbNode): string | null {
  if (node.type === "identifier") {
    return node.text;
  }
  if (node.type !== "call" || field(node, "arguments") !== null) {
    return null;
  }
  return field(node, "method")?.text ?? null;
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
