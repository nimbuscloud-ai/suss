// @suss/adapter-typescript — Phase 2 exports

export {
  createTypeScriptAdapter,
  extractCodeStructure,
} from "./adapter.js";
export { extractRawBranches } from "./assembly.js";
export { collectAncestorBranches, collectEarlyReturns } from "./conditions.js";
export { readContract, readContractForClientCall } from "./contract.js";
export { discoverUnits } from "./discovery/index.js";
export { createTsDiscoveryContext } from "./discoveryContext.js";
export { parseConditionExpression } from "./predicates.js";
export { collectClientFieldAccesses } from "./shapes/fieldAccesses.js";
export { resolveSubject } from "./subjects.js";
export { createTsSubUnitContext } from "./subUnitContext.js";
export { findTerminals } from "./terminals/index.js";
export { ADAPTER_VERSION, computeAdapterPacksDigest } from "./version.js";

export type {
  TypeScriptAdapter,
  TypeScriptAdapterConfig,
} from "./adapter.js";
export type { CacheDiagnostic, CacheLookup } from "./cache.js";
export type { FunctionRoot } from "./conditions.js";
export type { ContractReadResult } from "./contract.js";
export type { ClientCallSite, DiscoveredUnit } from "./discovery/index.js";
export type { TsDiscoveryContext } from "./discoveryContext.js";
export type {
  TsJsxAttributeLocation,
  TsSubUnitContext,
} from "./subUnitContext.js";
export type { FoundTerminal } from "./terminals/index.js";
export type { Timer, TimingReport } from "./timing.js";
