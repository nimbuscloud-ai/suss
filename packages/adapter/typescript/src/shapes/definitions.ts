// The types a summary refers to but does not spell out.
//
// A shape that gives a type's name rather than expanding it leaves a reader
// with a name and nowhere to look. The same type expanded at every
// mention is the other way to be unhelpful, and it is how one summary
// came to be a megabyte: 700 record nodes across 51 distinct shapes,
// the worst of them written out 143 times.
//
// So a named type is written once and named everywhere else. The table
// it is written into belongs to the unit being read, and the converter
// that meets the type is several calls below whoever knows which unit
// that is. Rather than thread a table through every shape call, the
// reader of one unit sets the table for as long as it takes to read it.
// The lifetime is one synchronous extraction, and a nested one puts the
// outer table back when it finishes.

import { compareText } from "./typeText.js";

import type { TypeShape } from "@suss/behavioral-ir";

export interface DefinitionTable {
  /** Whether this type is already written down, or being written now. */
  has(key: string): boolean;
  /**
   * Reserve a key before expanding it. A type that refers to itself
   * meets its own key part way through, and finding it taken is what
   * stops the expansion going round again.
   */
  reserve(key: string): void;
  define(key: string, shape: TypeShape): void;
  /**
   * Expand a reserved key once the expansion under way is done. One
   * named type mentions another, and expanding each inside the last ran
   * out of stack on a long enough chain of them.
   */
  defer(key: string, expand: () => TypeShape): void;
  /** Expand every deferred key, unless an outer call is already doing it. */
  settle(): void;
  /** Every definition worth carrying, or null when there are none. */
  collected(): Record<string, TypeShape> | null;
  /** The shape written under a key, null while it is only reserved. */
  shapeOf(key: string): TypeShape | null | undefined;
}

let current: DefinitionTable | null = null;

/** The table this unit's shapes are being written into, if any. */
export const definitionsInProgress = (): DefinitionTable | null => current;

export function createDefinitionTable(): DefinitionTable {
  const shapes = new Map<string, TypeShape | null>();
  const deferred: Array<{ key: string; expand: () => TypeShape }> = [];
  let settling = false;
  return {
    has: (key) => shapes.has(key),
    reserve: (key) => {
      shapes.set(key, null);
    },
    define: (key, shape) => {
      shapes.set(key, shape);
    },
    defer: (key, expand) => {
      deferred.push({ key, expand });
    },
    settle: () => {
      if (settling) {
        return;
      }
      settling = true;
      try {
        for (let next = deferred.shift(); next; next = deferred.shift()) {
          shapes.set(next.key, next.expand());
        }
      } finally {
        settling = false;
      }
    },
    // Sorted because the walk meets types in the checker's union order,
    // which changes between runs.
    collected: () => {
      const out: Record<string, TypeShape> = {};
      let any = false;
      const keys = [...shapes.keys()].sort(compareText);
      for (const key of keys) {
        const shape = shapes.get(key) ?? null;
        if (shape !== null) {
          out[key] = shape;
          any = true;
        }
      }
      return any ? out : null;
    },
    shapeOf: (key) => shapes.get(key),
  };
}

/**
 * Run `read` and give back every definition it looked up or wrote, so
 * a read that is not repeated can write the same ones into another
 * unit's table. Null when one of them was still being expanded, since
 * then there is no finished shape to hand on.
 */
export function withDefinitionsNoted<T>(read: () => T): {
  value: T;
  noted: Array<[string, TypeShape]> | null;
} {
  const table = current;
  if (table === null) {
    return { value: read(), noted: [] };
  }
  const keys = new Set<string>();
  current = {
    has: (key) => {
      keys.add(key);
      return table.has(key);
    },
    reserve: (key) => {
      keys.add(key);
      table.reserve(key);
    },
    define: (key, shape) => {
      keys.add(key);
      table.define(key, shape);
    },
    defer: (key, expand) => {
      keys.add(key);
      table.defer(key, expand);
    },
    settle: () => table.settle(),
    collected: () => table.collected(),
    shapeOf: (key) => table.shapeOf(key),
  };
  let value: T;
  try {
    value = read();
  } finally {
    current = table;
  }
  const noted: Array<[string, TypeShape]> = [];
  for (const key of keys) {
    const shape = table.shapeOf(key);
    if (shape === null || shape === undefined) {
      return { value, noted: null };
    }
    noted.push([key, shape]);
  }
  return { value, noted };
}

/** Write definitions `withDefinitionsNoted` gave back into this unit's table. */
export function writeNotedDefinitions(
  noted: ReadonlyArray<readonly [string, TypeShape]>,
): void {
  const table = current;
  if (table === null) {
    return;
  }
  for (const [key, shape] of noted) {
    if (!table.has(key)) {
      table.define(key, structuredClone(shape));
    }
  }
}

/**
 * Read one unit with a table of its own, and give back both what was
 * written into that table and what the read produced.
 */
export function withDefinitions<T>(read: () => T): {
  value: T;
  definitions: Record<string, TypeShape> | null;
} {
  const table = createDefinitionTable();
  const outer = current;
  current = table;
  try {
    return { value: read(), definitions: table.collected() };
  } finally {
    current = outer;
  }
}
