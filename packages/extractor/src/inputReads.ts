// What a unit reads out of what it was given.
//
// A summary said this already, in a way nobody could use. An input
// reference carried an empty `path` in every one of the 5,565 that suss
// produces reading itself, and what a handler actually reached for was
// spelled out somewhere else, as `derived` nodes nested one inside the
// next. Somebody asking "what does this read" wrote a recursive
// renderer by hand, and somebody querying the obvious field got nothing
// back and concluded the answer was missing.
//
// So the summary answers the question instead of leaving it to be
// reconstructed. Everything a unit reaches for through its inputs, once
// each, in the order a reader would say them.

import type { Predicate, ValueRef } from "@suss/behavioral-ir";

/** One thing a unit read, and the way it reached it. */
export interface InputRead {
  /** The input it came through, by the name the inputs table uses. */
  input: string;
  /** The properties walked to reach it, outermost first. */
  path: string[];
}

/**
 * Everything a unit reads out of its inputs, once each.
 *
 * A read is a chain of derivations ending at an input, so the walk goes
 * down to the input and builds the path back up. A derivation this does
 * not have a name for, an element access or a call in the middle, ends
 * the path there: what was reached is still worth saying, and inventing
 * a name for how would be worse than stopping.
 */
export function inputReadsOf(args: {
  conditions: Predicate[][];
  values: ValueRef[];
}): InputRead[] {
  const found = new Map<string, InputRead>();
  const keep = (read: InputRead | null): void => {
    if (read === null) {
      return;
    }
    found.set(`${read.input}.${read.path.join(".")}`, read);
  };

  for (const value of args.values) {
    keep(readOf(value));
  }
  for (const list of args.conditions) {
    for (const predicate of list) {
      for (const value of valuesIn(predicate)) {
        keep(readOf(value));
      }
    }
  }

  return [...found.values()].sort(
    (a, b) =>
      a.input.localeCompare(b.input) ||
      a.path.join(".").localeCompare(b.path.join(".")),
  );
}

/** The read a value stands for, or null when it does not come from an input. */
function readOf(value: ValueRef, depth = 0): InputRead | null {
  if (depth > 12) {
    return null;
  }
  if (value.type === "input") {
    return { input: value.inputRef, path: [...value.path] };
  }
  if (value.type !== "derived") {
    return null;
  }
  const inner = readOf(value.from, depth + 1);
  if (inner === null) {
    return null;
  }
  const step = stepOf(value.derivation);
  return step === null
    ? inner
    : { input: inner.input, path: [...inner.path, step] };
}

/** What one derivation adds to a path, or null when it adds no name. */
function stepOf(derivation: {
  type: string;
  [key: string]: unknown;
}): string | null {
  if (derivation.type === "propertyAccess") {
    return typeof derivation.property === "string" ? derivation.property : null;
  }
  if (derivation.type === "destructured") {
    return typeof derivation.field === "string" ? derivation.field : null;
  }
  return null;
}

/** Every value a predicate compares, however deeply it nests. */
function valuesIn(predicate: Predicate, depth = 0): ValueRef[] {
  if (depth > 12) {
    return [];
  }
  const out: ValueRef[] = [];
  const record = predicate as unknown as Record<string, unknown>;
  for (const value of Object.values(record)) {
    if (value === null || typeof value !== "object") {
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        out.push(...nested(item, depth));
      }
      continue;
    }
    out.push(...nested(value, depth));
  }
  return out;
}

function nested(value: unknown, depth: number): ValueRef[] {
  if (value === null || typeof value !== "object") {
    return [];
  }
  const kind = (value as { type?: unknown }).type;
  if (kind === "input" || kind === "derived") {
    return [value as ValueRef];
  }
  return valuesIn(value as Predicate, depth + 1);
}
