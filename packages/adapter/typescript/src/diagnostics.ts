// diagnostics.ts — the extraction funnel.
//
// "Why did this run produce nothing" is always "at which stage did the
// count reach zero", so the report is a funnel: files in the tsconfig,
// files the import gates selected, units discovered, summaries built.
// Each row is recorded by the stage that owns it, because the
// alternative is the CLI re-deriving the pre-filter's decisions from a
// second copy of its logic, and a second copy drifting from the first
// is what made an entire pack family extract nothing in silence.
//
// The gate-resolution row is the one that earns its keep. "No file
// imports @apollo/client" and "files import it but the specifier does
// not resolve" are different problems with different fixes, and
// without the check they look identical from outside: zero summaries,
// exit 0.

import path from "node:path";

import { ts } from "ts-morph";

import { collectPackGates, packIsUngated } from "./bootstrap/preFilter.js";

import type { PatternPack } from "@suss/extractor";

/** One pack's path through the funnel. */
export interface PackFunnel {
  pack: string;
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
  /** Summaries built from those units. */
  summariesProduced: number;
}

export interface ExtractionReport {
  /** Files in the tsconfig include set, or null when the caller supplied a Project. */
  filesInProject: number | null;
  /** Files the bootstrap loaded and the extract walked. */
  filesWalked: number;
  packs: PackFunnel[];
  summaries: number;
  /**
   * The first stage whose count was zero, when the run produced
   * nothing. Null when the run produced summaries.
   */
  emptyStage: EmptyStage | null;
}

export type EmptyStage =
  | "tsconfig"
  | "gateResolution"
  | "candidateFiles"
  | "discovery"
  | "assembly";

/** Per-pack running counts, filled as the extract proceeds. */
export interface PackTally {
  candidateFiles: number;
  unitsDiscovered: number;
  summariesProduced: number;
}

export function createPackTallies(
  packs: ReadonlyArray<PatternPack>,
): Map<string, PackTally> {
  const tallies = new Map<string, PackTally>();
  for (const pack of packs) {
    tallies.set(pack.name, {
      candidateFiles: 0,
      unitsDiscovered: 0,
      summariesProduced: 0,
    });
  }
  return tallies;
}

/**
 * The deepest directory holding every file, or undefined when the
 * paths share no absolute root. Stands in for the project root when no
 * tsconfig names one, since resolution from anywhere inside the tree
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
 * A tsconfig answers both. Without one there is still a directory the
 * walked files sit under, and resolving from there against bundler
 * defaults finds an installed dependency the same way the packs do.
 * Getting this right without a tsconfig matters more than it sounds:
 * `--dir` runs are exactly the ones aimed at projects that may not
 * have their dependencies installed, and a resolution check that
 * quietly answers "all fine" there turns every such run into a false
 * report of a broken pack.
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
 * summary carries the name of what recognised it, so grouping on that
 * attributes each one to the pack that owns it however late it arrived.
 */
export function buildExtractionReport(args: {
  packs: ReadonlyArray<PatternPack>;
  tallies: Map<string, PackTally>;
  filesInProject: number | null;
  filesWalked: number;
  summaries: number;
  tsConfigFilePath: string | undefined;
  /** Where to resolve gate specifiers from when there is no tsconfig. */
  projectRoot: string | undefined;
}): ExtractionReport {
  const packFunnels: PackFunnel[] = args.packs.map((pack) => {
    const gates = packIsUngated(pack) ? [] : collectPackGates(pack);
    const tally = args.tallies.get(pack.name) ?? {
      candidateFiles: 0,
      unitsDiscovered: 0,
      summariesProduced: 0,
    };
    return {
      pack: pack.name,
      gates,
      unresolvedGates: unresolvedGatesFor(gates, {
        tsConfigFilePath: args.tsConfigFilePath,
        projectRoot: args.projectRoot,
      }),
      candidateFiles: tally.candidateFiles,
      unitsDiscovered: tally.unitsDiscovered,
      summariesProduced: tally.summariesProduced,
    };
  });

  return {
    filesInProject: args.filesInProject,
    filesWalked: args.filesWalked,
    packs: packFunnels,
    summaries: args.summaries,
    emptyStage:
      args.summaries === 0 ? firstEmptyStage(packFunnels, args) : null,
  };
}

function firstEmptyStage(
  packs: ReadonlyArray<PackFunnel>,
  args: { filesInProject: number | null; filesWalked: number },
): EmptyStage {
  if (args.filesInProject === 0) {
    return "tsconfig";
  }
  if (packs.some((p) => p.unresolvedGates.length > 0)) {
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
