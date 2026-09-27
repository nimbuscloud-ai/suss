/**
 * What `inspect --diff` says about module lines, when a project lists its
 * modules in `suss.json`.
 *
 * Two things are reported. A store whose set of writing modules changed,
 * where a module writes a store when any of its code writes it, directly
 * or through the calls it makes. And a call from one module into another
 * that enters somewhere other than the callee's public exports. Both are
 * read off the summaries: the adapter stamps each one with its module,
 * and a module's public exports are the summaries it keys
 * `fn:<module>::<export>`. suss enforces nothing about module structure,
 * so these are lines in the diff and never a finding.
 */

import {
  BOUNDARY_ROLE,
  bindingIs,
  isModuleName,
  summaryIdentifier,
} from "@suss/behavioral-ir";
import { functionOf, readCallFacts } from "@suss/checker";

import { boundariesTouchedBy } from "./boundaryReach.js";
import { sentenceList } from "./sentenceList.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type { FunctionKey } from "@suss/checker";

/** A store whose writing modules differ between the two sides. */
export interface WritersChange {
  readonly store: string;
  readonly before: readonly string[];
  readonly after: readonly string[];
}

/** A call from one module into another that misses the callee's public exports. */
export interface ModuleCrossing {
  readonly from: string;
  readonly to: string;
  readonly caller: string;
  readonly callerFile: string;
  /** The call as the caller's source writes it. */
  readonly call: string;
  readonly target: string;
  readonly targetFile: string;
}

export interface ModuleChanges {
  readonly writers: readonly WritersChange[];
  readonly crossings: {
    readonly gained: readonly ModuleCrossing[];
    readonly lost: readonly ModuleCrossing[];
  };
}

export const NO_MODULE_CHANGES: ModuleChanges = {
  writers: [],
  crossings: { gained: [], lost: [] },
};

export function moduleChanges(
  before: readonly BehavioralSummary[],
  after: readonly BehavioralSummary[],
): ModuleChanges {
  if (!before.some(hasModule) && !after.some(hasModule)) {
    return NO_MODULE_CHANGES;
  }
  const crossingsBefore = crossingsOf(before);
  const crossingsAfter = crossingsOf(after);
  return {
    writers: writerChanges(writersByStore(before), writersByStore(after)),
    crossings: {
      gained: onlyIn(crossingsAfter, crossingsBefore),
      lost: onlyIn(crossingsBefore, crossingsAfter),
    },
  };
}

export function hasModuleChanges(changes: ModuleChanges): boolean {
  return (
    changes.writers.length +
      changes.crossings.gained.length +
      changes.crossings.lost.length >
    0
  );
}

function hasModule(summary: BehavioralSummary): boolean {
  return summary.location.module !== undefined;
}

// ---------------------------------------------------------------------------
// Which modules write each store
// ---------------------------------------------------------------------------

/**
 * The modules whose code writes each store. The walk goes backwards from
 * each function that writes the store to every function that ends up
 * calling it, once per store, so the cost is one walk per store rather
 * than one per unit.
 */
function writersByStore(
  summaries: readonly BehavioralSummary[],
): Map<string, Set<string>> {
  const facts = readCallFacts(summaries);
  const callers = new Map<FunctionKey, FunctionKey[]>();
  for (const edge of facts.edges()) {
    callers.set(edge.to, [...(callers.get(edge.to) ?? []), edge.from]);
  }

  const writing = new Map<string, Set<FunctionKey>>();
  for (const summary of summaries) {
    for (const touch of boundariesTouchedBy(summary)) {
      if (touch.relation !== "writes" || !bindingIs(touch.binding, "storage")) {
        continue;
      }
      const fns = writing.get(touch.label) ?? new Set<FunctionKey>();
      fns.add(functionOf(summary));
      writing.set(touch.label, fns);
    }
  }

  const byStore = new Map<string, Set<string>>();
  for (const [store, direct] of writing) {
    const modules = new Set<string>();
    for (const fn of reachingAny(direct, callers)) {
      for (const summary of facts.units.get(fn) ?? []) {
        if (summary.location.module !== undefined) {
          modules.add(summary.location.module);
        }
      }
    }
    byStore.set(store, modules);
  }
  return byStore;
}

function reachingAny(
  start: ReadonlySet<FunctionKey>,
  callers: ReadonlyMap<FunctionKey, FunctionKey[]>,
): Set<FunctionKey> {
  const seen = new Set(start);
  const frontier = [...start];
  while (frontier.length > 0) {
    const fn = frontier.pop() as FunctionKey;
    for (const caller of callers.get(fn) ?? []) {
      if (!seen.has(caller)) {
        seen.add(caller);
        frontier.push(caller);
      }
    }
  }
  return seen;
}

function writerChanges(
  before: ReadonlyMap<string, ReadonlySet<string>>,
  after: ReadonlyMap<string, ReadonlySet<string>>,
): WritersChange[] {
  const changes: WritersChange[] = [];
  for (const store of new Set([...before.keys(), ...after.keys()])) {
    const was = [...(before.get(store) ?? [])].sort();
    const is = [...(after.get(store) ?? [])].sort();
    if (was.join("\u0000") !== is.join("\u0000")) {
      changes.push({ store, before: was, after: is });
    }
  }
  return changes.sort((a, b) => a.store.localeCompare(b.store));
}

// ---------------------------------------------------------------------------
// Calls that enter a module off its public exports
// ---------------------------------------------------------------------------

/** The modules each function is a public export of, from its keyed bindings. */
function publicExports(
  summaries: readonly BehavioralSummary[],
): Map<FunctionKey, Set<string>> {
  const exportedBy = new Map<FunctionKey, Set<string>>();
  for (const summary of summaries) {
    const binding = summary.identity.boundaryBinding;
    if (
      BOUNDARY_ROLE[summary.kind] !== "provider" ||
      !bindingIs(binding, "function-call")
    ) {
      continue;
    }
    const { module, exportName } = binding.semantics;
    if (module === undefined || exportName === undefined) {
      continue;
    }
    if (!isModuleName(module)) {
      continue;
    }
    const fn = functionOf(summary);
    const modules = exportedBy.get(fn) ?? new Set<string>();
    modules.add(module);
    exportedBy.set(fn, modules);
  }
  return exportedBy;
}

/**
 * Every call written in one module's code that lands in another module on
 * a function that module does not export. A test is left out, since
 * reaching into a module's internals is what a test of it does.
 */
function crossingsOf(
  summaries: readonly BehavioralSummary[],
): Map<string, ModuleCrossing> {
  const byId = new Map(summaries.map((s) => [summaryIdentifier(s), s]));
  const exportedBy = publicExports(summaries);
  const crossings = new Map<string, ModuleCrossing>();
  for (const summary of summaries) {
    const from = summary.location.module;
    if (from === undefined || summary.kind === "test") {
      continue;
    }
    for (const transition of summary.transitions) {
      for (const effect of transition.effects) {
        if (effect.type !== "invocation" || effect.summary === undefined) {
          continue;
        }
        const callee = byId.get(effect.summary);
        const to = callee?.location.module;
        if (
          callee === undefined ||
          to === undefined ||
          to === from ||
          exportedBy.get(functionOf(callee))?.has(to) === true
        ) {
          continue;
        }
        const crossing: ModuleCrossing = {
          from,
          to,
          caller: summary.identity.name,
          callerFile: summary.location.file,
          call: effect.callee,
          target: callee.identity.name,
          targetFile: callee.location.file,
        };
        crossings.set(crossingKey(crossing), crossing);
      }
    }
  }
  return crossings;
}

function crossingKey(crossing: ModuleCrossing): string {
  return [
    crossing.callerFile,
    crossing.caller,
    crossing.targetFile,
    crossing.target,
  ].join("\u0000");
}

function onlyIn(
  side: ReadonlyMap<string, ModuleCrossing>,
  other: ReadonlyMap<string, ModuleCrossing>,
): ModuleCrossing[] {
  return [...side]
    .filter(([key]) => !other.has(key))
    .map(([, crossing]) => crossing)
    .sort(
      (a, b) =>
        a.from.localeCompare(b.from) ||
        a.to.localeCompare(b.to) ||
        a.caller.localeCompare(b.caller) ||
        a.target.localeCompare(b.target),
    );
}

// ---------------------------------------------------------------------------
// Printing
// ---------------------------------------------------------------------------

/** The block the printed diff shows, or nothing when no module line moved. */
export function moduleLines(changes: ModuleChanges): string[] {
  if (!hasModuleChanges(changes)) {
    return [];
  }
  return [
    "Module lines",
    "",
    ...changes.writers.map((change) => `  ${writersSentence(change)}`),
    ...changes.crossings.gained.map(
      (crossing) =>
        `  ${crossing.from} now calls ${crossing.to}'s ${crossing.target} (${crossing.targetFile}) from ${crossing.caller}, and ${crossing.to} does not export it.`,
    ),
    ...changes.crossings.lost.map(
      (crossing) =>
        `  ${crossing.from} no longer calls ${crossing.to}'s ${crossing.target} (${crossing.targetFile}) from ${crossing.caller}, which ${crossing.to} does not export.`,
    ),
    "",
  ];
}

function writersSentence(change: WritersChange): string {
  const added = change.after.filter((one) => !change.before.includes(one));
  const removed = change.before.filter((one) => !change.after.includes(one));
  const gone =
    removed.length === 0
      ? ""
      : ` ${sentenceList(removed)} no longer ${verb(removed, "writes", "write")} it.`;
  if (added.length === 0) {
    const still =
      change.after.length === 0
        ? "No module writes it now."
        : `${sentenceList(change.after)} still ${verb(change.after, "does", "do")}.`;
    return `${sentenceList(removed)} no longer ${verb(removed, "writes", "write")} ${change.store}. ${still}`;
  }
  const before =
    change.before.length === 0
      ? "no module did"
      : `only ${sentenceList(change.before)} did`;
  return `${sentenceList(added)} now ${verb(added, "writes", "write")} ${change.store}. Before this change ${before}.${gone}`;
}

function verb(names: readonly string[], one: string, many: string): string {
  return names.length === 1 ? one : many;
}
