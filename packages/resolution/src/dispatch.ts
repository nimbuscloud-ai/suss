/**
 * What a call may run when it takes its function out of a table, or
 * picks a member by a name it works out at run time: `COMMANDS[name](args)`,
 * `handlers.get(kind)(event)`, `getattr(self, kind)()`, Ruby's `send(kind)`.
 *
 * The rules list every function such a call may run. Whether it runs
 * exactly one is a count, which a rule cannot make, so it is decided
 * here: the source has to narrow the read to one name, and the entry
 * under that name has to be one function. Every other call may run any
 * of the functions listed, and a caller records them as possible rather
 * than as the one the call runs. DESIGN.md says which entries a read can
 * come back with.
 */

import { askResolution, resolutionProgram } from "./program.js";

import type { Database, OnDemandRules } from "@suss/datalog";

/** What a call that takes its function from a table may run. */
export interface DispatchOutcome {
  /** Every function the call may run, each once. */
  readonly functions: readonly string[];
  /** True when the source narrows the call to one entry that comes to one function. */
  readonly certain: boolean;
  /** How many entries came to no function this run read, any of which the call may run instead. */
  readonly unresolved: number;
  /** What each of `functions` calls in its own body, for an entry no summary describes, such as a lambda. */
  readonly through: ReadonlyMap<string, readonly string[]>;
  /** The tables and objects the call takes its function out of, for an adapter that reads their writes lazily. */
  readonly containers: readonly string[];
}

/**
 * The outcome for each of these calls that takes its function from a
 * table. A call that does not is left out of the map. One question for
 * the batch, so the rules are evaluated once.
 */
export function dispatchOutcomes(
  db: Database,
  calls: readonly string[],
  program: OnDemandRules = resolutionProgram(),
): Map<string, DispatchOutcome> {
  const outcomes = new Map<string, DispatchOutcome>();
  if (calls.length === 0) {
    return outcomes;
  }
  askResolution(db, calls, DISPATCH_QUESTION, program);
  return readDispatchOutcomes(db, calls);
}

/** What a caller asks through to learn what each call may run. */
export const DISPATCH_QUESTION = "wantedDispatch";

/**
 * The outcomes the rules derived for calls already asked about through
 * `DISPATCH_QUESTION`, for a store that evaluates the rules itself.
 */
export function readDispatchOutcomes(
  db: Database,
  calls: readonly string[],
): Map<string, DispatchOutcome> {
  const outcomes = new Map<string, DispatchOutcome>();
  for (const call of new Set(calls)) {
    const sites = column(db, "wantedDispatchSite", call, 1);
    if (sites.length === 0) {
      continue;
    }
    outcomes.set(call, outcomeOf(db, call, sites));
  }
  return outcomes;
}

function outcomeOf(
  db: Database,
  call: string,
  sites: readonly string[],
): DispatchOutcome {
  const byEntry = new Map<string, Set<string>>();
  for (const entry of column(db, "wantedDispatchEntry", call, 1)) {
    byEntry.set(entry, new Set());
  }
  for (const row of db.lookup("wantedDispatchFunction", 0, call)) {
    byEntry.get(String(row[1]))?.add(String(row[2]));
  }
  const functions = [
    ...new Set([...byEntry.values()].flatMap((found) => [...found])),
  ];
  const unresolved = [...byEntry.values()].filter(
    (found) => found.size === 0,
  ).length;
  const through = new Map<string, string[]>();
  for (const row of db.lookup("wantedDispatchThrough", 0, call)) {
    const inner = through.get(String(row[1])) ?? [];
    inner.push(String(row[2]));
    through.set(String(row[1]), inner);
  }
  return {
    functions,
    certain:
      functions.length === 1 &&
      unresolved === 0 &&
      narrowedToOneName(db, sites) &&
      column(db, "wantedDispatchComputed", call, 1).length === 0,
    unresolved,
    through,
    containers: [
      ...new Set(
        sites.flatMap((site) =>
          ENTRY_READS.flatMap((relation) => column(db, relation, site, 1)),
        ),
      ),
    ],
  };
}

/** The facts that say a read takes an entry out of a container. */
const ENTRY_READS = ["choosesEntry", "choosesNamedEntry", "readsEntry"];

/** Whether every read the call takes its function from is narrowed, and all of them to the same one name. */
function narrowedToOneName(db: Database, sites: readonly string[]): boolean {
  const names = new Set<string>();
  for (const site of sites) {
    if (db.lookup("choosesEntry", 0, site).length > 0) {
      return false;
    }
    for (const relation of NAMED_READS) {
      for (const row of db.lookup(relation, 0, site)) {
        names.add(String(row[2]));
      }
    }
  }
  return names.size === 1;
}

/** The facts that say which name an entry read is under. */
const NAMED_READS = ["choosesNamedEntry", "readsEntry"];

function column(
  db: Database,
  relation: string,
  key: string,
  at: number,
): string[] {
  return [
    ...new Set(db.lookup(relation, 0, key).map((row) => String(row[at]))),
  ];
}
