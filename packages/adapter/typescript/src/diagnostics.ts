// diagnostics.ts: the extraction funnel.
//
// "Why did this run produce nothing" is always "at which stage did the
// count reach zero", so the report is a funnel: files in the tsconfig,
// files the import gates selected, units discovered, summaries built.
// Each row is recorded by the stage that owns it, because the
// alternative is the CLI re-deriving the pre-filter's decisions from a
// second copy of its logic, and a second copy drifting from the first
// is what made an entire pack family extract nothing in silence.
//
// The gate-resolution row is the one worth having. "No file
// imports @apollo/client" and "files import it but the specifier does
// not resolve" are different problems with different fixes, and
// without the check they look identical from outside: zero summaries,
// exit 0.

import path from "node:path";

import { ts } from "ts-morph";

import { BOUNDARY_ROLE } from "@suss/behavioral-ir";

import { collectPackGates, packIsUngated } from "./bootstrap/preFilter.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type {
  DiscoveryPattern,
  PackDeclarations,
  PatternPack,
} from "@suss/extractor";

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
   * Gate specifiers that do not resolve from the tsconfig. Non-empty
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
   * written as a hand-rolled walk. This is the one thing in the funnel
   * that no run produces: it is the pack's own shape, and it is here so
   * the migration onto the declared surface can be measured.
   */
  declarations: PackDeclarations | null;
}

export interface ExtractionReport {
  /** Files in the tsconfig include set, or null when the caller supplied a Project. */
  filesInProject: number | null;
  /** Files the bootstrap loaded and the extract walked. */
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

const emptyTally = (): PackTally => ({
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
  packs: ReadonlyArray<PatternPack>,
): Map<string, PackTally> {
  const tallies = new Map<string, PackTally>();
  for (const pack of packs) {
    tallies.set(pack.name, emptyTally());
  }
  return tallies;
}

/**
 * The deepest directory that contains every file, or undefined when the
 * paths share no absolute root. Stands in for the project root when no
 * tsconfig gives one, since resolution from anywhere inside the tree
 * finds the same `node_modules`.
 */
export function commonDirectoryOf(
  files: ReadonlyArray<string>,
): string | undefined {
  const absolute = files.filter((f) => path.isAbsolute(f));
  const first = absolute[0];
  if (first === undefined) {
    return undefined;
  }

  let shared = path.dirname(first).split(path.sep);
  for (const file of absolute.slice(1)) {
    const parts = path.dirname(file).split(path.sep);
    let i = 0;
    while (i < shared.length && i < parts.length && shared[i] === parts[i]) {
      i += 1;
    }
    shared = shared.slice(0, i);
  }

  const joined = shared.join(path.sep);
  return joined.length > 1 ? joined : undefined;
}

/** Bundler-style defaults for a project that never wrote a tsconfig. */
const DEFAULT_RESOLUTION: ts.CompilerOptions = {
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  target: ts.ScriptTarget.ESNext,
  module: ts.ModuleKind.ESNext,
};

/**
 * Where module resolution should be anchored, and under which options.
 *
 * A tsconfig settles both. Without one there is still a directory the
 * walked files are under, and resolving from there against bundler
 * defaults finds an installed dependency the same way the packs do.
 * Getting this right without a tsconfig matters more than it sounds:
 * `--dir` runs are aimed at exactly the projects that may not have their
 * dependencies installed, and a resolution check that quietly says "all
 * fine" there turns every such run into a false report of a broken pack.
 */
function resolutionContext(args: {
  tsConfigFilePath: string | undefined;
  projectRoot: string | undefined;
}): { containingFile: string; options: ts.CompilerOptions } | null {
  if (args.tsConfigFilePath !== undefined) {
    const configFile = ts.readConfigFile(
      args.tsConfigFilePath,
      ts.sys.readFile,
    );
    if (configFile.error !== undefined) {
      return null;
    }

    const dir = path.dirname(args.tsConfigFilePath);
    const parsed = ts.parseJsonConfigFileContent(
      configFile.config,
      ts.sys,
      dir,
      /*existingOptions*/ undefined,
      args.tsConfigFilePath,
    );
    return {
      containingFile: path.join(dir, "index.ts"),
      options: parsed.options,
    };
  }

  if (args.projectRoot === undefined || !path.isAbsolute(args.projectRoot)) {
    return null;
  }

  return {
    containingFile: path.join(args.projectRoot, "index.ts"),
    options: DEFAULT_RESOLUTION,
  };
}

/**
 * Check each gate specifier against the project's module resolution.
 * Returns the specifiers that do not resolve.
 */
export function unresolvedGatesFor(
  gates: ReadonlyArray<string>,
  args: {
    tsConfigFilePath: string | undefined;
    projectRoot: string | undefined;
  },
): string[] {
  if (gates.length === 0) {
    return [];
  }

  const context = resolutionContext(args);
  if (context === null) {
    return [];
  }

  const unresolved: string[] = [];
  for (const gate of gates) {
    const resolved = ts.resolveModuleName(
      gate,
      context.containingFile,
      context.options,
      ts.sys,
    );
    if (resolved.resolvedModule === undefined) {
      unresolved.push(gate);
    }
  }
  return unresolved;
}

/**
 * The summary-side funnel counts, per pack.
 *
 * These are read back off the finished run rather than tallied during
 * it, because the summaries a pack is responsible for are not all built
 * where the pack is in scope: wrapper expansion and sub-unit synthesis
 * both add summaries after the discovery loop has moved on. Every
 * summary records what recognised it, so grouping on that gets each one
 * back to the pack that owns it however late it arrived.
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

function summaryCountsByPack(
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
 * The registration helpers the run read out of the project that no call
 * then matched, each written with the file it was read from, so
 * somebody can see which routes went missing.
 */
function helpersWithNoCall(
  patterns: ReadonlyArray<DiscoveryPattern>,
  matched: ReadonlySet<string>,
  projectRoot: string | undefined,
): string[] {
  const missing: string[] = [];
  for (const pattern of patterns) {
    if (
      pattern.match.type !== "registrationTemplate" ||
      matched.has(pattern.match.helperName)
    ) {
      continue;
    }
    const from = pattern.match.importModule;
    missing.push(
      from === undefined
        ? pattern.match.helperName
        : `${pattern.match.helperName} from ${shortModule(from, projectRoot)}`,
    );
  }
  return missing;
}

/** A path the pack already resolved, back to where somebody reads it. */
function shortModule(module: string, projectRoot: string | undefined): string {
  if (projectRoot === undefined || !path.isAbsolute(module)) {
    return module;
  }
  return path.relative(projectRoot, module);
}

export function buildExtractionReport(args: {
  packs: ReadonlyArray<PatternPack>;
  tallies: Map<string, PackTally>;
  filesInProject: number | null;
  filesWalked: number;
  summaries: ReadonlyArray<BehavioralSummary>;
  tsConfigFilePath: string | undefined;
  /** Where to resolve gate specifiers from when there is no tsconfig. */
  projectRoot: string | undefined;
  /** Files whose exports the checker could not follow. */
  filesWithUnreadableExports?: ReadonlyArray<string>;
  /** Reassigned names the run stated nothing for. */
  reassignedNamesUnstated?: number;
  /** What each pack added after reading the project's own helpers. */
  contributedPatterns?: (packName: string) => ReadonlyArray<DiscoveryPattern>;
}): ExtractionReport {
  const bySummary = summaryCountsByPack(args.summaries);

  const packFunnels: PackFunnel[] = args.packs.map((pack) => {
    const gates = packIsUngated(pack) ? [] : collectPackGates(pack);
    const tally = args.tallies.get(pack.name) ?? emptyTally();
    const counted = bySummary.get(pack.name) ?? emptyCounts();
    return {
      pack: pack.name,
      version: pack.version ?? null,
      discovers: pack.discovery.length > 0 || pack.discoverUnits !== undefined,
      recognizes:
        (pack.invocationRecognizers?.length ?? 0) > 0 ||
        (pack.accessRecognizers?.length ?? 0) > 0,
      gates,
      unresolvedGates: unresolvedGatesFor(gates, {
        tsConfigFilePath: args.tsConfigFilePath,
        projectRoot: args.projectRoot,
      }),
      candidateFiles: tally.candidateFiles,
      unitsDiscovered: tally.unitsDiscovered,
      unitsInGatedFiles: tally.unitsInGatedFiles,
      effectsRecognized: tally.effectsRecognized,
      unitsClaimed: tally.unitsClaimed,
      selfCollisions: tally.selfCollisions,
      summariesProduced: tally.summariesProduced,
      failures: tally.failures,
      helpersUnmatched: helpersWithNoCall(
        [...pack.discovery, ...(args.contributedPatterns?.(pack.name) ?? [])],
        tally.helpersMatched,
        args.projectRoot,
      ),
      summariesBound: counted.bound,
      providerSummaries: counted.providers,
      summariesWithBehavior: counted.withBehavior,
      declarations: pack.declarations ?? null,
    };
  });

  return {
    filesInProject: args.filesInProject,
    filesWalked: args.filesWalked,
    packs: packFunnels,
    summaries: args.summaries.length,
    filesWithUnreadableExports: [...(args.filesWithUnreadableExports ?? [])],
    reassignedNamesUnstated: args.reassignedNamesUnstated ?? 0,
    emptyStage:
      args.summaries.length === 0 ? firstEmptyStage(packFunnels, args) : null,
  };
}

function firstEmptyStage(
  packs: ReadonlyArray<PackFunnel>,
  args: { filesInProject: number | null; filesWalked: number },
): EmptyStage {
  if (args.filesInProject === 0) {
    return "tsconfig";
  }
  // An uninstalled dependency only explains an empty run when something
  // in the project asked for it. The pre-filter is what tells the two
  // apart: it matches on import text, so a file importing a missing
  // package still counts as a candidate. No candidates and a missing
  // package together mean the project does not use it, and telling
  // someone to install it would be advice they cannot act on.
  const gateFailed = packs.some(
    (p) => p.unresolvedGates.length > 0 && p.candidateFiles > 0,
  );
  if (gateFailed) {
    return "gateResolution";
  }
  if (args.filesWalked === 0 || packs.every((p) => p.candidateFiles === 0)) {
    return "candidateFiles";
  }
  if (packs.every((p) => p.unitsDiscovered === 0)) {
    return "discovery";
  }
  return "assembly";
}
