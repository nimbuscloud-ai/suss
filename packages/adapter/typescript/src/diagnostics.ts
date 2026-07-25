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
 * Check each gate specifier against the tsconfig's module resolution.
 * Returns the specifiers that do not resolve.
 *
 * Skipped without a tsconfig path, since there is no resolution
 * context to check against and a caller-supplied Project may be
 * entirely in memory.
 */
export function unresolvedGatesFor(
  gates: ReadonlyArray<string>,
  tsConfigFilePath: string | undefined,
): string[] {
  if (tsConfigFilePath === undefined || gates.length === 0) {
    return [];
  }

  const configFile = ts.readConfigFile(tsConfigFilePath, ts.sys.readFile);
  if (configFile.error !== undefined) {
    return [];
  }
  const parsed = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    path.dirname(tsConfigFilePath),
    /*existingOptions*/ undefined,
    tsConfigFilePath,
  );

  const containingFile = path.join(path.dirname(tsConfigFilePath), "index.ts");
  const unresolved: string[] = [];
  for (const gate of gates) {
    const resolved = ts.resolveModuleName(
      gate,
      containingFile,
      parsed.options,
      ts.sys,
    );
    if (resolved.resolvedModule === undefined) {
      unresolved.push(gate);
    }
  }
  return unresolved;
}

export function buildExtractionReport(args: {
  packs: ReadonlyArray<PatternPack>;
  tallies: Map<string, PackTally>;
  filesInProject: number | null;
  filesWalked: number;
  summaries: number;
  tsConfigFilePath: string | undefined;
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
      unresolvedGates: unresolvedGatesFor(gates, args.tsConfigFilePath),
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
