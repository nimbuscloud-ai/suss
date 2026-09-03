/**
 * The extraction funnel, shared across languages.
 *
 * "Why did this run produce nothing" is always "at which stage did the
 * count reach zero", so the report is a funnel: files in the tsconfig,
 * files the import gates selected, units discovered, summaries built.
 * Each row is recorded by the stage that owns it, because the
 * alternative is the CLI re-deriving the pre-filter's decisions from a
 * second copy of its logic, and a second copy drifting from the first
 * is what made an entire pack family extract nothing in silence.
 *
 * TypeScript, Python and Ruby all build one of these, though only
 * TypeScript gates files by import specifier today. A pack with no gate
 * concept reports it the way TypeScript reports an ungated pack.
 */

import { BOUNDARY_ROLE } from "@suss/behavioral-ir";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type { PackDeclarations } from "./framework.js";

/** One pack's path through the funnel. */
export interface PackFunnel {
  pack: string;
  /**
   * What the pack calls this build of itself, or null when it declares
   * nothing. The cache keys on it, so a pack that never changes its
   * stamp can serve a later run with an earlier build's results.
   */
  version: string | null;
  /**
   * Whether the pack looks for units of its own at all. A pack made only
   * of recognisers contributes effects to units other packs found, so it
   * always discovers nothing, and that tells you nothing about whether
   * it is working.
   */
  discovers: boolean;
  /**
   * Whether the pack has any recognisers. Those fire inside units other
   * packs discovered, so a pack made only of them contributes effects
   * and never a summary.
   */
  recognizes: boolean;
  /**
   * Import specifiers that make a file relevant to this pack. Empty
   * for an ungated pack, which walks every file.
   */
  gates: string[];
  /**
   * Gate specifiers that do not resolve from the project. Non-empty
   * here usually means the target project's dependencies are not
   * installed, which stops symbol-resolution packs while leaving
   * textual-gate packs working, so the run half-succeeds in a way
   * nothing else surfaces.
   */
  unresolvedGates: string[];
  /** Files the pre-filter selected for this pack. */
  candidateFiles: number;
  /** Units discovered across those files. */
  unitsDiscovered: number;
  /**
   * Unit bodies any pack walked in the files this pack's gate selected.
   *
   * This is what a recogniser pack had the chance to fire on. Its own
   * discovery count tells you nothing, since it discovers nothing by
   * design, and neither does its candidate-file count, because a
   * recogniser only runs where some pack found a unit to walk.
   */
  unitsInGatedFiles: number;
  /** Effects this pack's recognisers returned. */
  effectsRecognized: number;
  /**
   * Units this pack kept. A unit an earlier pack already claimed is
   * dropped here, so a pack can discover plenty and keep none when it
   * comes after a pack that recognises the same code.
   */
  unitsClaimed: number;
  /**
   * Units this pack discovered twice over. Cross-pack dedup is the
   * point of the claim set, but a pack colliding with itself means its
   * own discovery patterns overlap and one of the two is being thrown
   * away without anybody deciding which.
   */
  selfCollisions: number;
  /** Summaries built from those units. */
  summariesProduced: number;
  /** Summaries in the finished run that credit this pack for finding them. */
  summariesBound: number;
  /**
   * Bound summaries on the provider side of their boundary.
   *
   * Kept apart from the count below because a provider that produced
   * no transitions is a different problem from a client that produced
   * none.
   */
  providerSummaries: number;
  /**
   * Summaries with at least one transition, of any role. A provider's
   * transitions say what it does with a request and a client's say what
   * it expects back, so a pack whose summaries have none has bound
   * something and described nothing either way.
   */
  summariesWithBehavior: number;
  /**
   * Where one of this pack's hooks threw. Every count above is a floor
   * while this is non-empty.
   */
  failures: PackFailure[];
  /**
   * Registration helpers this pack's config asked for that no call in
   * the run matched. The helper belongs to the project, so a spelling
   * that matches nothing is a config mistake with no other symptom: the
   * routes go missing and every count reads the same as a project
   * without them.
   */
  helpersUnmatched: string[];
  /**
   * What the pack wrote as data rather than as code, or null for a pack
   * written as a hand-rolled walk, or for a language whose packs have
   * no declared-pattern system at all. This is the one thing in the
   * funnel that no run produces: it is the pack's own shape, and it is
   * here so the migration onto the declared surface can be measured.
   */
  declarations: PackDeclarations | null;
}

export interface ExtractionReport {
  /** Files in the project's include set, or null when nothing states one separately from the walk. */
  filesInProject: number | null;
  /** Files the adapter loaded and the extract walked. */
  filesWalked: number;
  packs: PackFunnel[];
  summaries: number;
  /**
   * Files whose exports the checker could not follow, so the run read
   * them as exporting nothing.
   *
   * Without this the artifact cannot tell the two apart: a module whose
   * barrel chain outran the call stack and a module that really does
   * export nothing both produce no summaries and exit 0.
   * Anything reachable only through these files is missing, and every
   * count below is a floor while this is non-empty.
   */
  filesWithUnreadableExports: string[];
  /**
   * The first stage whose count was zero, when the run produced
   * nothing. Null when the run produced summaries.
   */
  emptyStage: EmptyStage | null;
  /**
   * Reassigned names the run stated nothing for, because control flow
   * decides which write a reader sees. Each is a value resolution the
   * facts decline; the count across a large corpus says whether scoped
   * reaching definitions is worth writing.
   */
  reassignedNamesUnstated: number;
}

export type EmptyStage =
  | "tsconfig"
  | "gateResolution"
  | "candidateFiles"
  | "discovery"
  | "assembly";

/**
 * A pack's hook throwing on one file.
 *
 * The run continues with the other files, so every count for that pack
 * afterwards is a floor rather than a total. Somebody reading those
 * counts has to be told, or a pack that broke looks the same as a pack
 * that looked and found nothing.
 */
export interface PackFailure {
  /** The hook that threw, called what a pack author would call it. */
  hook: string;
  /** The file the pack was reading. */
  file: string;
  message: string;
}

/** Per-pack running counts, filled as the extract proceeds. */
export interface PackTally {
  candidateFiles: number;
  unitsDiscovered: number;
  unitsInGatedFiles: number;
  effectsRecognized: number;
  unitsClaimed: number;
  selfCollisions: number;
  summariesProduced: number;
  failures: PackFailure[];
  /** Registration helpers from this pack's config that produced a unit. */
  helpersMatched: Set<string>;
}

export const emptyTally = (): PackTally => ({
  candidateFiles: 0,
  unitsDiscovered: 0,
  unitsInGatedFiles: 0,
  effectsRecognized: 0,
  unitsClaimed: 0,
  selfCollisions: 0,
  summariesProduced: 0,
  failures: [],
  helpersMatched: new Set(),
});

/**
 * Record that a pack's hook threw, and phrase it in one sentence a caller
 * can print. Both callers want the same wording, and a failure that only
 * reached stderr left the counts looking like an empty pack.
 */
export function recordPackFailure(
  tally: PackTally | undefined,
  failure: { pack: string; hook: string; file: string; error: unknown },
): string {
  const message =
    failure.error instanceof Error
      ? failure.error.message
      : String(failure.error);
  tally?.failures.push({
    hook: failure.hook,
    file: failure.file,
    message,
  });
  return `[suss] pack "${failure.pack}" threw from ${failure.hook} while reading ${failure.file}: ${message}\n`;
}

export function createPackTallies(
  packs: ReadonlyArray<{ name: string }>,
): Map<string, PackTally> {
  const tallies = new Map<string, PackTally>();
  for (const pack of packs) {
    tallies.set(pack.name, emptyTally());
  }
  return tallies;
}

/** Credit the pack whose name a raw unit's boundary binding gives as `recognition`. */
export function tallyUnit(
  tallies: Map<string, PackTally>,
  recognition: string | undefined,
): void {
  const tally =
    recognition === undefined ? undefined : tallies.get(recognition);
  if (tally === undefined) {
    return;
  }
  tally.unitsDiscovered += 1;
  tally.summariesProduced += 1;
}

/**
 * The summary-side funnel counts, per pack.
 *
 * These are read back off the finished run rather than tallied during
 * it, because the summaries a pack is responsible for are not all built
 * where the pack is in scope: wrapper expansion and sub-unit synthesis
 * both add summaries after discovery has moved on. Every summary
 * records what recognised it, so grouping on that gets each one back to
 * the pack that owns it however late it arrived.
 */
interface SummaryCounts {
  bound: number;
  providers: number;
  withBehavior: number;
}

const emptyCounts = (): SummaryCounts => ({
  bound: 0,
  providers: 0,
  withBehavior: 0,
});

export function summaryCountsByPack(
  summaries: ReadonlyArray<BehavioralSummary>,
): Map<string, SummaryCounts> {
  const counts = new Map<string, SummaryCounts>();
  for (const summary of summaries) {
    const recognition = summary.identity.boundaryBinding?.recognition;
    if (recognition === undefined || recognition === null) {
      continue;
    }

    const entry = counts.get(recognition) ?? emptyCounts();
    entry.bound += 1;
    if (BOUNDARY_ROLE[summary.kind] === "provider") {
      entry.providers += 1;
    }
    if (summary.transitions.length > 0) {
      entry.withBehavior += 1;
    }
    counts.set(recognition, entry);
  }
  return counts;
}

/**
 * An extraction report for an adapter with no gate stage of its own,
 * the way TypeScript reports an ungated pack: every file is a
 * candidate, and `unitsClaimed` tracks `unitsDiscovered` one for one
 * because nothing dedups across packs yet.
 */
export function buildUngatedExtractionReport(args: {
  packs: ReadonlyArray<{
    name: string;
    version: string | null;
    discovers: boolean;
  }>;
  tallies: ReadonlyMap<string, PackTally>;
  filesWalked: number;
  summaries: ReadonlyArray<BehavioralSummary>;
}): ExtractionReport {
  const bySummary = summaryCountsByPack(args.summaries);

  const packFunnels: PackFunnel[] = args.packs.map((pack) => {
    const tally = args.tallies.get(pack.name) ?? emptyTally();
    const counted = bySummary.get(pack.name) ?? emptyCounts();
    return {
      pack: pack.name,
      version: pack.version,
      discovers: pack.discovers,
      recognizes: false,
      gates: [],
      unresolvedGates: [],
      candidateFiles: args.filesWalked,
      unitsDiscovered: tally.unitsDiscovered,
      unitsInGatedFiles: 0,
      effectsRecognized: 0,
      unitsClaimed: tally.unitsDiscovered,
      selfCollisions: 0,
      summariesProduced: tally.summariesProduced,
      failures: tally.failures,
      helpersUnmatched: [],
      summariesBound: counted.bound,
      providerSummaries: counted.providers,
      summariesWithBehavior: counted.withBehavior,
      declarations: null,
    };
  });

  return {
    filesInProject: null,
    filesWalked: args.filesWalked,
    packs: packFunnels,
    summaries: args.summaries.length,
    filesWithUnreadableExports: [],
    reassignedNamesUnstated: 0,
    emptyStage:
      args.summaries.length === 0
        ? firstEmptyUngatedStage(packFunnels, args.filesWalked)
        : null,
  };
}

function firstEmptyUngatedStage(
  packs: ReadonlyArray<PackFunnel>,
  filesWalked: number,
): EmptyStage {
  if (filesWalked === 0) {
    return "candidateFiles";
  }
  if (packs.every((p) => p.unitsDiscovered === 0)) {
    return "discovery";
  }
  return "assembly";
}
