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
  /** Every definition worth carrying, or null when there are none. */
  collected(): Record<string, TypeShape> | null;
}

let current: DefinitionTable | null = null;

/** The table this unit's shapes are being written into, if any. */
export const definitionsInProgress = (): DefinitionTable | null => current;

export function createDefinitionTable(): DefinitionTable {
  const shapes = new Map<string, TypeShape | null>();
  return {
    has: (key) => shapes.has(key),
    reserve: (key) => {
      shapes.set(key, null);
    },
    define: (key, shape) => {
      shapes.set(key, shape);
    },
    collected: () => {
      const out: Record<string, TypeShape> = {};
      let any = false;
      for (const [key, shape] of shapes) {
        if (shape !== null) {
          out[key] = shape;
          any = true;
        }
      }
      return any ? out : null;
    },
  };
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
