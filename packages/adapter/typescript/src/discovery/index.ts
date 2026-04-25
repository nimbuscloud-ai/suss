// discovery/index.ts — orchestrator + public surface for the discovery
// layer. Each match-type handler lives in its own sibling file; this
// file is the dispatch table and dedup pass that callers see.

import { discoverClientCalls } from "./clientCall.js";
import { discoverDecoratedMethods } from "./decoratedMethod.js";
import { discoverDecoratedRoutes } from "./decoratedRoute.js";
import { discoverGraphqlHookCalls } from "./graphqlHookCall.js";
import { discoverGraphqlImperativeCalls } from "./graphqlImperativeCall.js";
import { discoverNamedExports } from "./namedExport.js";
import { discoverPackageExports } from "./packageExports.js";
import { discoverPackageImports } from "./packageImport.js";
import { discoverRegistrationCalls } from "./registrationCall.js";
import { discoverResolverMaps } from "./resolverMap.js";

import type { DiscoveryPattern } from "@suss/extractor";
import type { SourceFile } from "ts-morph";

export { clearPackageExportsCache } from "./packageExports.js";
export { toFunctionRoot } from "./shared.js";

export type { ClientCallSite, DiscoveredUnit } from "./shared.js";

import type { DiscoveredUnit } from "./shared.js";

function runPattern(
  sourceFile: SourceFile,
  pattern: DiscoveryPattern,
): DiscoveredUnit[] {
  if (pattern.match.type === "namedExport") {
    return discoverNamedExports(sourceFile, pattern.match, pattern.kind);
  }
  if (pattern.match.type === "registrationCall") {
    return discoverRegistrationCalls(sourceFile, pattern.match, pattern.kind);
  }
  if (pattern.match.type === "clientCall") {
    return discoverClientCalls(sourceFile, pattern.match, pattern.kind);
  }
  if (pattern.match.type === "graphqlHookCall") {
    return discoverGraphqlHookCalls(sourceFile, pattern.match, pattern.kind);
  }
  if (pattern.match.type === "graphqlImperativeCall") {
    return discoverGraphqlImperativeCalls(
      sourceFile,
      pattern.match,
      pattern.kind,
    );
  }
  if (pattern.match.type === "resolverMap") {
    return discoverResolverMaps(sourceFile, pattern.match, pattern.kind);
  }
  if (pattern.match.type === "packageExports") {
    return discoverPackageExports(sourceFile, pattern.match, pattern.kind);
  }
  if (pattern.match.type === "packageImport") {
    return discoverPackageImports(sourceFile, pattern.match, pattern.kind);
  }
  if (pattern.match.type === "decoratedMethod") {
    return discoverDecoratedMethods(sourceFile, pattern.match, pattern.kind);
  }
  if (pattern.match.type === "decoratedRoute") {
    return discoverDecoratedRoutes(sourceFile, pattern.match, pattern.kind);
  }
  // fileConvention: stub; discovery returns empty until a concrete pack
  // motivates implementing it.
  return [];
}

/**
 * Discover code units in `sourceFile` by running all patterns.
 * Deduplicates entries with the same function node and kind.
 */
export function discoverUnits(
  sourceFile: SourceFile,
  patterns: DiscoveryPattern[],
): DiscoveredUnit[] {
  const allResults: DiscoveredUnit[] = [];

  for (const pattern of patterns) {
    const found = runPattern(sourceFile, pattern);
    for (const unit of found) {
      unit.pattern = pattern;
    }
    allResults.push(...found);
  }

  // Deduplicate: same node + same kind → keep first occurrence. Units
  // tagged with `packageExportInfo` additionally distinguish on the
  // consumed binding — one enclosing function can legitimately emit
  // multiple caller units, one per imported library function it calls.
  const seen = new Set<string>();
  const deduped: DiscoveredUnit[] = [];

  for (const unit of allResults) {
    const bindingSuffix =
      unit.packageExportInfo !== undefined
        ? `-${unit.packageExportInfo.packageName}::${unit.packageExportInfo.exportPath.join(".")}`
        : "";
    const key = `${unit.func.getStart()}-${unit.func.getEnd()}-${unit.kind}${bindingSuffix}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(unit);
    }
  }

  return deduped;
}
