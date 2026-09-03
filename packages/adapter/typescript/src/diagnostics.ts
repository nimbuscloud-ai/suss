/**
 * TypeScript's own funnel building, on top of the shared report shape
 * in `@suss/extractor`.
 *
 * The gate-resolution row is the one worth having. "No file
 * imports @apollo/client" and "files import it but the specifier does
 * not resolve" are different problems with different fixes, and
 * without the check they look identical from outside: zero summaries,
 * exit 0.
 */

import path from "node:path";

import { ts } from "ts-morph";

import {
  createPackTallies,
  emptyTally,
  recordPackFailure,
  summaryCountsByPack,
} from "@suss/extractor";

import { collectPackGates, packIsUngated } from "./bootstrap/preFilter.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type {
  DiscoveryPattern,
  EmptyStage,
  ExtractionReport,
  PackFailure,
  PackFunnel,
  PackTally,
  PatternPack,
} from "@suss/extractor";

export type {
  EmptyStage,
  ExtractionReport,
  PackFailure,
  PackFunnel,
  PackTally,
};
export { createPackTallies, recordPackFailure };

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
    const counted = bySummary.get(pack.name) ?? {
      bound: 0,
      providers: 0,
      withBehavior: 0,
    };
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
