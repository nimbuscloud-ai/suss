/**
 * Which fields of a response a client reads, worked out the same way
 * for every adapter.
 *
 *   const res = await fetch(`/orders/${id}`);
 *   const order = await res.json();
 *   return order.customerName;
 *
 * The walk in `@suss/resolution` follows `order` back to `res.json()`.
 * The adapter says which node is the request, and which nodes are a
 * value taken from another, such as `res.json()`, the body of `res`.
 * This module chains those steps back to the request. DESIGN.md says
 * which values get a place and which do not.
 */

import { testsStatus } from "@suss/behavioral-ir";

import type { StatusMembers, TypeShape } from "@suss/behavioral-ir";
import type { RawCondition } from "./index.js";

/** One place a value's walk ended, and the properties read off it on the way. */
export interface ReadStop<N> {
  /** The node the walk ended at, or null when the walk keyed none. */
  readonly node: N | null;
  /** The properties read off it on the way to the value, outermost first. */
  readonly path: readonly string[];
  /** Whether the walk ended at an expression written out, such as a literal default. */
  readonly written?: boolean;
}

/** A node whose value is taken from another value. */
export interface ReadHop<N> {
  /** The value it was taken from. */
  readonly from: N;
  /** The members of `from` it reads, `["json"]` for `res.json()`. */
  readonly segments: readonly string[];
}

/** What only the adapter can say about the response a client reads. */
export interface ResponseReading<N> {
  /** The same key for every handle on one node. */
  idOf(node: N): string | number;
  /**
   * Where each value's walk ended, asked as one question and keyed by
   * `idOf`. A walk also ends at a node `endsAt` picks.
   */
  stopsOf(
    values: readonly N[],
    endsAt: (node: N) => boolean,
  ): ReadonlyMap<string | number, readonly ReadStop<N>[]>;
  /** Whether the node is the request call whose response this is. */
  isRequest(node: N): boolean;
  /** The value a node is taken from, or null when it is not such a node. */
  hopOf(node: N): ReadHop<N> | null;
  /**
   * Whether `stop` is written later in the same file than `read`. The
   * walk follows a name to its last write, so a name written twice
   * leads an early read to a value it never sees.
   */
  writtenAfter(stop: N, read: N): boolean;
}

/** Past this many steps from a value back to the request, the value is left unplaced. */
const MAX_STEPS = 8;

/**
 * Where in the response each value is, as a function of the value. The
 * values given are asked about together; a step that reaches a value
 * nobody asked about asks the walk again.
 */
export function placesInResponse<N>(
  values: readonly N[],
  reading: ResponseReading<N>,
): (value: N) => readonly string[] | null {
  const stops = new Map<string | number, readonly ReadStop<N>[]>();
  const placed = new Map<string | number, readonly string[] | null>();
  const hops = new Map<string | number, ReadHop<N> | null>();
  const inProgress = new Set<string | number>();

  const hopOf = (node: N): ReadHop<N> | null => {
    const id = reading.idOf(node);
    if (!hops.has(id)) {
      hops.set(id, reading.hopOf(node));
    }
    return hops.get(id) ?? null;
  };

  // The adapter follows a step itself, so only the value at the end of
  // the steps needs the walk.
  const needsWalk = (value: N): N | null => {
    let current = value;
    for (let step = 0; step <= MAX_STEPS; step++) {
      if (reading.isRequest(current)) {
        return null;
      }
      const hop = hopOf(current);
      if (hop === null) {
        return current;
      }
      current = hop.from;
    }
    return null;
  };

  const ask = (asked: readonly N[]): void => {
    const fresh = new Map<string | number, N>();
    for (const value of asked) {
      const walked = needsWalk(value);
      if (walked !== null && !stops.has(reading.idOf(walked))) {
        fresh.set(reading.idOf(walked), walked);
      }
    }
    if (fresh.size === 0) {
      return;
    }
    const found = reading.stopsOf(
      [...fresh.values()],
      (node) => reading.isRequest(node) || hopOf(node) !== null,
    );
    for (const id of fresh.keys()) {
      stops.set(id, found.get(id) ?? []);
    }
  };

  // Undefined for a node that is neither the request nor a step.
  const endPlace = (
    node: N,
    depth: number,
  ): readonly string[] | null | undefined => {
    if (reading.isRequest(node)) {
      return [];
    }
    const hop = hopOf(node);
    if (hop === null) {
      return undefined;
    }
    const base = placeOf(hop.from, depth + 1);
    return base === null ? null : [...base, ...hop.segments];
  };

  const valuePlace = (value: N, depth: number): readonly string[] | null => {
    const direct = endPlace(value, depth);
    if (direct !== undefined) {
      return direct;
    }
    ask([value]);
    let agreed: readonly string[] | null = null;
    for (const stop of stops.get(reading.idOf(value)) ?? []) {
      const end = stopPlace(stop, value, depth);
      if (end === "skip") {
        continue;
      }
      const here = end === null ? null : [...end, ...stop.path];
      if (here === null || (agreed !== null && !samePath(agreed, here))) {
        return null;
      }
      agreed = here;
    }
    return agreed;
  };

  // A write after the read is a value the read never sees, and a value
  // written out, such as a literal default, is not another response.
  const stopPlace = (
    stop: ReadStop<N>,
    value: N,
    depth: number,
  ): readonly string[] | null | "skip" => {
    if (stop.node === null) {
      return null;
    }
    if (reading.writtenAfter(stop.node, value)) {
      return "skip";
    }
    const end = endPlace(stop.node, depth + 1);
    if (end === undefined) {
      return stop.written === true ? "skip" : null;
    }
    return end;
  };

  const placeOf = (value: N, depth: number): readonly string[] | null => {
    const id = reading.idOf(value);
    const known = placed.get(id);
    if (known !== undefined) {
      return known;
    }
    if (depth > MAX_STEPS || inProgress.has(id)) {
      return null;
    }
    inProgress.add(id);
    const found = valuePlace(value, depth);
    inProgress.delete(id);
    placed.set(id, found);
    return found;
  };

  ask(values);
  return (value) => placeOf(value, 0);
}

function samePath(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((segment, i) => segment === b[i]);
}

/**
 * Whether a guard decides which response a read sees, for `readsOn`: a
 * test on one of these status or success members. A guard nobody could
 * parse might be one, so it counts too.
 */
export function decidesResponse(
  members: StatusMembers,
): (guard: RawCondition) => boolean {
  return (guard) =>
    guard.structured === null || testsStatus(guard.structured, members);
}

/**
 * The record of fields a set of reads takes, each read given as the
 * members read off the response, outermost first. Reads that share a
 * prefix nest, so `["json", "name"]` and `["json", "email"]` make one
 * `json` record with both fields. A leaf is `unknown`, since a read says
 * the caller needs the field and nothing about its type.
 */
export function readShapeOf(
  reads: readonly (readonly string[])[],
): TypeShape | null {
  const nested = new Map<string, (readonly string[])[]>();
  const leaves = new Set<string>();
  for (const read of reads) {
    const [head, ...tail] = read;
    if (head === undefined) {
      continue;
    }
    if (tail.length === 0) {
      leaves.add(head);
      continue;
    }
    nested.set(head, [...(nested.get(head) ?? []), tail]);
  }
  const properties: Record<string, TypeShape> = {};
  for (const leaf of leaves) {
    if (!nested.has(leaf)) {
      properties[leaf] = { type: "unknown" };
    }
  }
  for (const [name, tails] of nested) {
    properties[name] = readShapeOf(tails) ?? { type: "unknown" };
  }
  return Object.keys(properties).length === 0
    ? null
    : { type: "record", properties };
}
