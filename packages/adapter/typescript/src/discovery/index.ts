// discovery/index.ts: orchestrator + public surface for the discovery
// layer. Each match-type handler lives in its own sibling file; this
// file is the dispatch table and dedup pass that callers see.

import { ResolutionStore } from "../facts/store.js";
import { discoverClientCalls } from "./clientCall.js";
import { discoverDecoratedMethods } from "./decoratedMethod.js";
import { discoverDecoratedRoutes } from "./decoratedRoute.js";
import { discoverFileConventions } from "./fileConvention.js";
import { discoverGraphqlHookCalls } from "./graphqlHookCall.js";
import { discoverGraphqlImperativeCalls } from "./graphqlImperativeCall.js";
import { discoverJsxElementRoutes } from "./jsxElementRoute.js";
import { discoverNamedExports } from "./namedExport.js";
import { discoverPackageExports } from "./packageExports.js";
import { discoverPackageImports } from "./packageImport.js";
import { discoverRegistrationCalls } from "./registrationCall.js";
import { discoverRegistrationLoops } from "./registrationLoop.js";
import { discoverRegistrationTemplates } from "./registrationTemplate.js";
import { discoverResolverMaps } from "./resolverMap.js";

import type { DiscoveryPattern } from "@suss/extractor";
import type { SourceFile } from "ts-morph";
import type {
  ExpandedRegistrations,
  MountPrefixIndex,
} from "./registrationCall.js";

export { clearPackageExportsCache } from "./packageExports.js";
export { toFunctionRoot, unitDedupKey } from "./shared.js";

export type { MountPrefixIndex } from "./registrationCall.js";
export type { ClientCallSite, DiscoveredUnit } from "./shared.js";

import { unitDedupKey } from "./shared.js";

import type { DiscoveredUnit } from "./shared.js";

function runPattern(
  sourceFile: SourceFile,
  pattern: DiscoveryPattern,
  resolution?: ResolutionStore,
  mountPrefixes?: MountPrefixIndex,
  expandedElsewhere?: ExpandedRegistrations,
  routeWrapperPattern?: DiscoveryPattern,
): DiscoveredUnit[] {
  if (pattern.match.type === "namedExport") {
    return discoverNamedExports(
      sourceFile,
      pattern.match,
      pattern.kind,
      resolution,
    );
  }
  if (pattern.match.type === "registrationCall") {
    return discoverRegistrationCalls(
      sourceFile,
      pattern.match,
      pattern.kind,
      pattern.bindingExtraction,
      resolution,
      mountPrefixes,
      expandedElsewhere,
      routeWrapperPattern,
    );
  }
  if (pattern.match.type === "registrationTemplate") {
    return discoverRegistrationTemplates(
      sourceFile,
      pattern.match,
      pattern.kind,
      resolution,
      mountPrefixes,
    );
  }
  if (pattern.match.type === "registrationLoop") {
    return discoverRegistrationLoops(
      sourceFile,
      pattern.match,
      pattern.kind,
      resolution,
    );
  }
  if (pattern.match.type === "clientCall") {
    return discoverClientCalls(
      sourceFile,
      pattern.match,
      pattern.kind,
      resolution,
    );
  }
  if (pattern.match.type === "graphqlHookCall") {
    return discoverGraphqlHookCalls(
      sourceFile,
      pattern.match,
      pattern.kind,
      resolution,
    );
  }
  if (pattern.match.type === "graphqlImperativeCall") {
    return discoverGraphqlImperativeCalls(
      sourceFile,
      pattern.match,
      pattern.kind,
      resolution,
    );
  }
  if (pattern.match.type === "resolverMap") {
    return discoverResolverMaps(
      sourceFile,
      pattern.match,
      pattern.kind,
      resolution,
    );
  }
  if (pattern.match.type === "packageExports") {
    return discoverPackageExports(
      sourceFile,
      pattern.match,
      pattern.kind,
      resolution,
    );
  }
  if (pattern.match.type === "packageImport") {
    if (resolution === undefined) {
      return [];
    }
    return discoverPackageImports(
      sourceFile,
      pattern.match,
      pattern.kind,
      resolution,
    );
  }
  if (pattern.match.type === "decoratedMethod") {
    return discoverDecoratedMethods(
      sourceFile,
      pattern.match,
      pattern.kind,
      resolution,
    );
  }
  if (pattern.match.type === "decoratedRoute") {
    return discoverDecoratedRoutes(
      sourceFile,
      pattern.match,
      pattern.kind,
      resolution,
      pattern.binding,
    );
  }
  if (pattern.match.type === "jsxElementRoute") {
    return discoverJsxElementRoutes(
      sourceFile,
      pattern.match,
      pattern.kind,
      resolution,
    );
  }
  if (pattern.match.type === "fileConvention") {
    return discoverFileConventions(
      sourceFile,
      pattern.match,
      pattern.kind,
      resolution,
    );
  }
  return [];
}

/**
 * The pack's declaration for a middleware that runs for every route,
 * `app.use(fn)` with the continuation it calls, which is also how a
 * middleware listed on one route is read. A pack with no such
 * declaration has its route chains read as before: last function only.
 */
function routeWrapperPatternOf(
  patterns: readonly DiscoveryPattern[],
): DiscoveryPattern | undefined {
  return patterns.find(
    (pattern) =>
      pattern.wraps !== undefined &&
      "method" in pattern.wraps &&
      pattern.wraps.continuationParam !== undefined &&
      pattern.wraps.throwParam === undefined &&
      pattern.wraps.arity === undefined &&
      pattern.wraps.scopePosition === undefined,
  );
}

/**
 * Discover code units in `sourceFile` by running all patterns.
 * Deduplicates entries with the same function node and kind.
 */
export function discoverUnits(
  sourceFile: SourceFile,
  patterns: DiscoveryPattern[],
  resolution?: ResolutionStore,
  mountPrefixes?: MountPrefixIndex,
  expandedElsewhere?: ExpandedRegistrations,
): DiscoveredUnit[] {
  // The adapter passes its run's store; a bare call gets its own,
  // since reading an export table needs one.
  const store = resolution ?? new ResolutionStore();
  const allResults: DiscoveredUnit[] = [];
  const routeWrapperPattern = routeWrapperPatternOf(patterns);

  for (const pattern of patterns) {
    const found = runPattern(
      sourceFile,
      pattern,
      store,
      mountPrefixes,
      expandedElsewhere,
      routeWrapperPattern,
    );
    for (const unit of found) {
      // A handler that already says which pattern to read it with is a
      // middleware listed on a route, read with the pack's middleware
      // declaration rather than the route pattern that found it.
      unit.pattern ??= pattern;
    }
    allResults.push(...found);
  }

  // Keep the first unit under each identity; a pattern that matches the
  // same boundary twice should not produce it twice.
  const seen = new Set<string>();
  const deduped: DiscoveredUnit[] = [];

  for (const unit of allResults) {
    const key = unitDedupKey(unit);
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(unit);
    }
  }

  return deduped;
}
