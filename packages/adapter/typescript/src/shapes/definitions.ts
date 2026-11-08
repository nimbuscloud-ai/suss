/**
 * The types a summary refers to but does not spell out.
 *
 * A named type is written once into the table of the unit being read and
 * named everywhere else. The converter that meets a type is several calls
 * below whoever knows which unit that is, so the reader of one unit sets
 * the table for as long as it takes to read it, and a nested read puts
 * the outer table back when it finishes.
 *
 * A definition refers to further types, and the table keeps only those a
 * reader can reach: one met `MAX_SHAPE_DEPTH` levels or more below the
 * top of every shape mentioning it is never substituted, so it is left
 * out. The shapes README says why.
 */

import { MAX_SHAPE_DEPTH, withChildShapes } from "@suss/behavioral-ir";

import { compareText } from "./typeText.js";

import type { TypeShape } from "@suss/behavioral-ir";

/** A named type met in a shape, `depth` levels below the top of the shape it was met in. */
export interface DefinitionMention {
  key: string;
  depth: number;
  source: DefinitionSource;
}

/** Where a mention goes: into a unit's table, or into the expansion that met it. */
export interface DefinitionSink {
  mention(found: DefinitionMention): void;
}

/**
 * How to expand one named type, run at most once. Each table that needs
 * the type takes its own copy, since a repeated body walk hands the same
 * source to a second unit's table.
 */
export interface DefinitionSource {
  take(): { shape: TypeShape; mentions: readonly DefinitionMention[] };
}

let current: DefinitionSink | null = null;

/** Where this unit's named types are being written, if anywhere. */
export const definitionsInProgress = (): DefinitionSink | null => current;

/**
 * A source for the type `expand` reads. The named types the expansion
 * meets are kept with it rather than written anywhere, so a table can
 * decide for itself which of them it needs.
 */
export function definitionSource(expand: () => TypeShape): DefinitionSource {
  let expanded: { value: TypeShape; held: DefinitionMention[] } | null = null;
  return {
    take: () => {
      expanded ??= withMentionsHeld(expand);
      // Passes after assembly may edit a summary's shapes in place.
      return {
        shape: structuredClone(expanded.value),
        mentions: expanded.held,
      };
    },
  };
}

interface Entry {
  /** The first mention's, so the shape does not depend on later ones. */
  source: DefinitionSource;
  /** The fewest levels below the top of a shape any mention reached it at. */
  depth: number;
  /** Null until a reader can reach the type. */
  taken: ReturnType<DefinitionSource["take"]> | null;
}

export interface DefinitionTable extends DefinitionSink {
  /** Every definition a reader can reach, or null when there are none. */
  collected(): Record<string, TypeShape> | null;
}

export function createDefinitionTable(): DefinitionTable {
  const entries = new Map<string, Entry>();
  // Expanded after the expansion under way, not inside it: one named
  // type mentions another, and expanding each inside the last ran out of
  // stack on a long enough chain of them.
  const pending: Entry[] = [];

  const reach = ({ key, depth, source }: DefinitionMention): void => {
    const known = entries.get(key);
    if (known !== undefined && depth >= known.depth) {
      return;
    }
    const entry = known ?? { source, depth, taken: null };
    entry.depth = depth;
    entries.set(key, entry);
    if (depth < MAX_SHAPE_DEPTH) {
      pending.push(entry);
    }
  };

  // A type met again closer to the top brings the types it refers to
  // closer too, so a key already written down is reached from again.
  const settle = (): void => {
    for (let at = 0; at < pending.length; at++) {
      const entry = pending[at];
      entry.taken ??= entry.source.take();
      for (const inner of entry.taken.mentions) {
        reach({ ...inner, depth: entry.depth + inner.depth });
      }
    }
    pending.length = 0;
  };

  return {
    // An expansion writes what it mentions into its own source, so nothing
    // calls in here while `settle` runs.
    mention: (found) => {
      reach(found);
      settle();
    },
    // Sorted because the walk meets types in the checker's union order,
    // which changes between runs.
    collected: () => {
      const kept = new Map<string, TypeShape>();
      for (const key of [...entries.keys()].sort(compareText)) {
        const taken = entries.get(key)?.taken ?? null;
        if (taken !== null) {
          kept.set(key, taken.shape);
        }
      }
      if (kept.size === 0) {
        return null;
      }
      const out: Record<string, TypeShape> = {};
      for (const [key, shape] of kept) {
        out[key] = withKeysLeftOutDropped(shape, kept);
      }
      return out;
    },
  };
}

/**
 * The shape with the key taken off every ref to a type the table left
 * out, so the ref reads the way one the depth cap wrote does: a project
 * type named and not spelled out.
 */
function withKeysLeftOutDropped(
  shape: TypeShape,
  kept: ReadonlyMap<string, TypeShape>,
): TypeShape {
  if (shape.type === "ref") {
    const { def, ...named } = shape;
    return def === undefined || kept.has(def) ? shape : named;
  }
  return withChildShapes(shape, (inner) => withKeysLeftOutDropped(inner, kept));
}

/**
 * Run `read` and give back every named type it mentioned, so a read that
 * is not repeated can mention the same ones in another unit's table.
 */
export function withDefinitionsNoted<T>(read: () => T): {
  value: T;
  noted: DefinitionMention[];
} {
  const sink = current;
  const noted: DefinitionMention[] = [];
  if (sink === null) {
    return { value: read(), noted };
  }
  current = {
    mention: (found) => {
      noted.push(found);
      sink.mention(found);
    },
  };
  try {
    return { value: read(), noted };
  } finally {
    current = sink;
  }
}

/**
 * Run `read` and give back the named types it mentioned without passing
 * them on, for a read whose shape may be thrown away. Nothing is held,
 * and named types are expanded where they are met, when no unit is
 * collecting definitions.
 */
export function withMentionsHeld<T>(read: () => T): {
  value: T;
  held: DefinitionMention[];
} {
  const sink = current;
  const held: DefinitionMention[] = [];
  if (sink === null) {
    return { value: read(), held };
  }
  current = { mention: (found) => held.push(found) };
  try {
    return { value: read(), held };
  } finally {
    current = sink;
  }
}

/** Mention in this unit's table what `withDefinitionsNoted` or `withMentionsHeld` gave back. */
export function writeNotedDefinitions(
  noted: readonly DefinitionMention[],
): void {
  const sink = current;
  if (sink === null) {
    return;
  }
  for (const found of noted) {
    sink.mention(found);
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
