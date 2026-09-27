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

import { children, field, NodeMap } from "./ast.js";
import { askSourceQuestions, sourcesOf } from "./facts/resolve.js";
import { operandsOf } from "./paths/predicates.js";
import { methodStorage } from "./storage.js";
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
import type { EffectSlot, RbStorageOptions } from "./storage.js";

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
 * Asks both source questions for these methods at once, so each body's
 * own questions find their keys already asked. DESIGN.md says why a
 * caller passes only the methods that become units.
 */
export function askFileSources(
  methods: readonly RbNode[],
  file: string,
  facts: Database,
  storage: RbStorageOptions | undefined,
): void {
  const operands = methods.flatMap(guardSubjectsIn);
  const values =
    storage === undefined
      ? []
      : methods.flatMap((method) =>
          methodStorage(method, file, storage).slots.map((one) => one.value),
        );
  askSourceQuestions(facts, keysOf(operands), "wantedInputRead");
  askSourceQuestions(facts, keysOf(values), "wantedSource");
}

/**
 * The same for bodies that may be written in several files, a question
 * per file, since reading a body's storage work needs the file it is in.
 */
export function askSourcesOfBodies(
  bodies: ReadonlyArray<{ file: string; method: RbNode }>,
  facts: Database | undefined,
  storage: RbStorageOptions | undefined,
): void {
  if (facts === undefined) {
    return;
  }
  const byFile = new Map<string, RbNode[]>();
  for (const { file, method } of bodies) {
    byFile.set(file, [...(byFile.get(file) ?? []), method]);
  }
  for (const [file, methods] of byFile) {
    askFileSources(methods, file, facts, storage);
  }
}

/** The nodes whose `condition` a body's paths branch on. */
const BRANCHING = new Set([
  "if",
  "unless",
  "elsif",
  "while",
  "until",
  "if_modifier",
  "unless_modifier",
  "while_modifier",
  "until_modifier",
  "conditional",
]);

/** The subjects of every branch condition written in a method. */
function guardSubjectsIn(method: RbNode): RbNode[] {
  const found: RbNode[] = [];
  const visit = (node: RbNode): void => {
    const condition = BRANCHING.has(node.type)
      ? field(node, "condition")
      : null;
    if (condition !== null) {
      found.push(...operandsOf(condition));
    }
    for (const child of children(node)) {
      visit(child);
    }
  };
  visit(method);
  return found;
}

function keysOf(nodes: readonly RbNode[]): string[] {
  const keys = new Set<string>();
  for (const node of nodes) {
    const key = resolutionKeyOf(node);
    if (key !== null) {
      keys.add(key);
    }
  }
  return [...keys];
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
