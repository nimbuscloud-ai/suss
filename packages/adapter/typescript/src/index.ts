// @suss/adapter-typescript — Phase 2 exports

export {
  createTypeScriptAdapter,
  extractCodeStructure,
} from "./adapter.js";
export { extractRawBranches } from "./assembly.js";
export {
  createProjectWithoutTsconfig,
  findNearestTsconfig,
} from "./bootstrap/noTsconfigProject.js";
export { collectAncestorBranches } from "./conditions.js";
export { readConfiguredCall } from "./configuredCall.js";
export { readContract, readContractForClientCall } from "./contract.js";
export { discoverUnits } from "./discovery/index.js";
export { createTsDiscoveryContext } from "./discoveryContext.js";
// The store behind the recognizer context's `resolveWrittenValue`.
// Exported so a pack's test harness can hand recognizers the same
// resolution the adapter threads through at extraction time.
export { ResolutionStore } from "./facts/store.js";
// Reading a module's exports and following an import to what it names
// are the adapter's to do, not each pack's: both walk re-export chains
// that overflow the checker when asked about naively, and the handling
// belongs in one place.
export {
  exportedDeclarationsOf,
  resolveAliasedSymbol,
} from "./moduleExports.js";
export { evaluatePackHealth, formatPackHealth } from "./packHealth.js";
export { parseConditionExpression } from "./predicates.js";
export { isImportedFrom } from "./resolve/invocationEffects.js";
export { collectClientFieldAccesses } from "./shapes/fieldAccesses.js";
export { resolveSubject } from "./subjects.js";
export { createTsSubUnitContext } from "./subUnitContext.js";
export { findTerminals } from "./terminals/index.js";
export {
  ADAPTER_VERSION,
  computeAdapterPacksDigest,
  computeContentHash,
} from "./version.js";

export type {
  TypeScriptAdapter,
  TypeScriptAdapterConfig,
} from "./adapter.js";
export type { CacheDiagnostic, CacheLookup } from "./cache.js";
export type { FunctionRoot } from "./conditions.js";
export type {
  ConfiguredCallContext,
  ConfiguredCallRead,
  ConfiguredCallSpec,
} from "./configuredCall.js";
export type { ContractReadResult } from "./contract.js";
export type {
  EmptyStage,
  ExtractionReport,
  PackFunnel,
} from "./diagnostics.js";
export type { ClientCallSite, DiscoveredUnit } from "./discovery/index.js";
export type { TsDiscoveryContext } from "./discoveryContext.js";
export type { HealthCheck, HealthViolation } from "./packHealth.js";
export type {
  TsJsxAttributeLocation,
  TsSubUnitContext,
} from "./subUnitContext.js";
export type { FoundTerminal } from "./terminals/index.js";
export type { Timer, TimingReport } from "./timing.js";
