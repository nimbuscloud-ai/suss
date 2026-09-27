/**
 * Where a value came from, read from the rows `wantedSource` derives.
 *
 * The rules give the chain as steps. This rebuilds the walk from the
 * value outward and hands back each place it ended, with the properties
 * read off that place on the way to the value. Saying what an ending
 * means (an input, a literal, a call the walk could not follow) is the
 * adapter's job, since each language spells a parameter and a literal
 * its own way. DESIGN.md has the rules and the reasons.
 */

import { askResolution, resolutionProgram } from "./program.js";

import type { Database, OnDemandRules } from "@suss/datalog";

/** What the walk ended at. */
export type SourceEnd =
  /** A parameter of the function `of`. The walk never goes on to the callers. */
  | { is: "parameter"; of: string }
  /** A name imported from a module no file in the run defines. */
  | { is: "import"; module: string; name: string }
  /** A call whose result the walk could not follow. */
  | { is: "call" }
  /** An expression written out in the source, such as a literal. */
  | { is: "written" }
  /** Anything else with no step out of it. */
  | { is: "other" };

/** One place a value's walk ended. */
export interface SourceLeaf {
  /** The key of the chain member the walk ended at. */
  key: string;
  /** The properties read off it on the way to the value, outermost first. */
  path: string[];
  /**
   * The read nearest the value that takes an entry at a key the source
   * computes, or null when the way there reads none. The path leaves
   * that key out, so a caller that needs the whole path stops here.
   */
  computedAt: string | null;
  /** The language's own conversions on the way to the value, outermost first. */
  conversions: string[];
  end: SourceEnd;
}

/** One step out of a chain member, and what it read or converted on the way. */
interface Step {
  to: string;
  property: string | null;
  computed: boolean;
  conversion: string | null;
}

/**
 * How far the walk goes. `wantedSource` follows a call into what its
 * function returns. `wantedInputRead` follows a name to what it was
 * written as and a read to what it was read off, and stops at a call,
 * which is enough to say which input a guard tests.
 */
export type SourceQuestion = "wantedSource" | "wantedInputRead";

/** Ask where each value came from, and read where each walk ended. */
export function askSources(
  db: Database,
  keys: readonly string[],
  program: OnDemandRules = resolutionProgram(),
  question: SourceQuestion = "wantedSource",
): Map<string, SourceLeaf[]> {
  const found = new Map<string, SourceLeaf[]>();
  if (keys.length === 0) {
    return found;
  }
  askResolution(db, keys, question, program);
  for (const key of keys) {
    found.set(key, sourceLeavesOf(db, key));
  }
  return found;
}

/**
 * Every place the walk from `key` ended, for a store that has already
 * asked `wantedSource` about it. A parameter always ends the walk, even
 * when a step leads on from it, since the step goes into the caller's
 * code or a declared type rather than to the value.
 */
export function sourceLeavesOf(db: Database, key: string): SourceLeaf[] {
  const steps = stepsFrom(db, key);
  const parameters = new Map<string, string>();
  for (const row of db.lookup("wantedSourceParam", 0, key)) {
    parameters.set(String(row[1]), String(row[2]));
  }

  const leaves: SourceLeaf[] = [];
  const seen = new Set<string>([key]);
  const queue: Array<Omit<SourceLeaf, "end">> = [
    { key, path: [], computedAt: null, conversions: [] },
  ];
  for (let at = 0; at < queue.length; at += 1) {
    const here = queue[at];
    const of = parameters.get(here.key);
    if (of !== undefined) {
      leaves.push({ ...here, end: { is: "parameter", of } });
      continue;
    }
    const out = steps.get(here.key) ?? [];
    if (out.length === 0) {
      leaves.push({ ...here, end: endOf(db, key, here.key) });
      continue;
    }
    for (const step of out) {
      if (seen.has(step.to)) {
        continue;
      }
      seen.add(step.to);
      queue.push({
        key: step.to,
        path:
          step.property === null ? here.path : [step.property, ...here.path],
        computedAt: here.computedAt ?? (step.computed ? here.key : null),
        conversions:
          step.conversion === null
            ? here.conversions
            : [...here.conversions, step.conversion],
      });
    }
  }
  // The steps come in the order the rules derived them, which depends on
  // the order facts arrived in.
  return leaves.sort((a, b) => a.key.localeCompare(b.key));
}

/** The chain's steps, by the member each leaves from. */
function stepsFrom(db: Database, key: string): Map<string, Step[]> {
  const steps = new Map<string, Step[]>();
  const add = (from: string, step: Step): void => {
    const already = steps.get(from);
    if (already === undefined) {
      steps.set(from, [step]);
      return;
    }
    already.push(step);
  };
  const plain = { property: null, computed: false, conversion: null };
  for (const row of db.lookup("wantedSourceHop", 0, key)) {
    add(String(row[1]), { ...plain, to: String(row[2]) });
  }
  for (const row of db.lookup("wantedSourceRead", 0, key)) {
    add(String(row[1]), {
      ...plain,
      to: String(row[2]),
      property: String(row[3]),
    });
  }
  for (const row of db.lookup("wantedSourceKeyed", 0, key)) {
    add(String(row[1]), { ...plain, to: String(row[2]), computed: true });
  }
  for (const row of db.lookup("wantedSourceConverts", 0, key)) {
    add(String(row[1]), {
      ...plain,
      to: String(row[2]),
      conversion: String(row[3]),
    });
  }
  return steps;
}

/** What a member with no step out of it is. An import says most. */
function endOf(db: Database, key: string, member: string): SourceEnd {
  for (const row of db.lookup("wantedSourceImport", 0, key)) {
    if (String(row[1]) === member) {
      return { is: "import", module: String(row[2]), name: String(row[3]) };
    }
  }
  if (hasRow(db, "wantedSourceCall", key, member)) {
    return { is: "call" };
  }
  if (hasRow(db, "wantedSourceWritten", key, member)) {
    return { is: "written" };
  }
  return { is: "other" };
}

function hasRow(
  db: Database,
  relation: string,
  key: string,
  member: string,
): boolean {
  return db.lookup(relation, 0, key).some((row) => String(row[1]) === member);
}
