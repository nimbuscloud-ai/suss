// preFilter.ts — gate per-file discovery dispatch by `requiresImport`.
//
// Most packs declare an `importGate`-style trigger on each
// DiscoveryPattern: a list of module specifiers that must appear in
// a file's imports for the pattern to be relevant. Files where NO
// pattern of NO pack matches don't need their discovery dispatch
// run at all — the AST walks would find nothing.
//
// On a monorepo with thousands of TS files where the active packs
// only target one framework, this typically excludes the large
// majority of files from per-file discovery work.
//
// Match semantics: `requiresImport: ["@foo/bar"]` matches imports
// from `"@foo/bar"` AND `"@foo/bar/sub-path"`. Empty array (or
// undefined) means "no gate" — the pattern applies to every file.

import type { PatternPack } from "@suss/extractor";
import type { SourceFile } from "ts-morph";

/**
 * For each source file, compute the subset of packs that have at
 * least one applicable DiscoveryPattern. Files mapped to an empty
 * (or absent) pack list can be skipped entirely.
 *
 * Reads imports via ts-morph's already-parsed AST — fast, no
 * additional file I/O. Phase 3 (lazy file loading) swaps this for
 * a `ts.preProcessFile` token scan against unparsed file content.
 */
export function computePackApplicability(
  sourceFiles: ReadonlyArray<SourceFile>,
  packs: ReadonlyArray<PatternPack>,
): Map<SourceFile, PatternPack[]> {
  // Pre-classify each pack as either ungated (matches every file)
  // or gated (needs an import match). Lets the per-file inner loop
  // skip ungated packs from the import scan entirely.
  const ungatedPacks: PatternPack[] = [];
  const gatedPacks: Array<{ pack: PatternPack; gates: string[] }> = [];
  for (const pack of packs) {
    if (packIsUngated(pack)) {
      ungatedPacks.push(pack);
    } else {
      gatedPacks.push({ pack, gates: collectPackGates(pack) });
    }
  }

  const result = new Map<SourceFile, PatternPack[]>();
  for (const sf of sourceFiles) {
    const applicable: PatternPack[] = [...ungatedPacks];
    if (gatedPacks.length > 0) {
      const importedModules = sf
        .getImportDeclarations()
        .map((d) => d.getModuleSpecifierValue());
      for (const { pack, gates } of gatedPacks) {
        if (anyImportMatchesGate(importedModules, gates)) {
          applicable.push(pack);
        }
      }
    }
    if (applicable.length > 0) {
      result.set(sf, applicable);
    }
  }
  return result;
}

function packIsUngated(pack: PatternPack): boolean {
  // A pack-level `requiresImport` is ALWAYS a gate, even on
  // recognizer-only packs. Lets `@suss/framework-aws-sqs` declare
  // `["@aws-sdk/client-sqs"]` and skip files that don't import it.
  if (pack.requiresImport !== undefined && pack.requiresImport.length > 0) {
    return false;
  }
  // Recognizer-only packs (no discovery patterns, only invocation /
  // access recognizers) without a pack-level gate fall through to
  // "ungated" — they walk every file because they have no other way
  // to declare relevance. Truly universal recognizers like
  // `@suss/framework-process-env` (process.env is always available)
  // are the intended consumers of this fallback.
  const hasInvocationRecognizers =
    pack.invocationRecognizers !== undefined &&
    pack.invocationRecognizers.length > 0;
  const hasAccessRecognizers =
    pack.accessRecognizers !== undefined && pack.accessRecognizers.length > 0;
  if (
    pack.discovery.length === 0 &&
    (hasInvocationRecognizers || hasAccessRecognizers)
  ) {
    return true;
  }
  for (const pattern of pack.discovery) {
    const requires = pattern.requiresImport;
    if (requires === undefined || requires.length === 0) {
      return true;
    }
  }
  return false;
}

function collectPackGates(pack: PatternPack): string[] {
  const gates = new Set<string>();
  // Pack-level gate (recognizer-only packs use this).
  if (pack.requiresImport !== undefined) {
    for (const g of pack.requiresImport) {
      gates.add(g);
    }
  }
  // Per-discovery-pattern gates (existing mechanism).
  for (const pattern of pack.discovery) {
    const requires = pattern.requiresImport;
    if (requires === undefined) {
      continue;
    }
    for (const g of requires) {
      gates.add(g);
    }
  }
  return [...gates];
}

/**
 * Prefix match — `@foo/bar` matches `@foo/bar` AND `@foo/bar/sub`.
 * Mirrors how npm packages export sub-paths.
 */
function anyImportMatchesGate(
  importedModules: ReadonlyArray<string>,
  gates: ReadonlyArray<string>,
): boolean {
  for (const mod of importedModules) {
    for (const gate of gates) {
      if (mod === gate || mod.startsWith(`${gate}/`)) {
        return true;
      }
    }
  }
  return false;
}
