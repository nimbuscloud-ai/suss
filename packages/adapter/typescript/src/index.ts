// @suss/adapter-typescript — Phase 2 exports

export {
  createTypeScriptAdapter,
  extractCodeStructure,
} from "./adapter.js";
export { extractRawBranches } from "./assembly.js";
export { collectAncestorBranches, collectEarlyReturns } from "./conditions.js";
export { readContract, readContractForClientCall } from "./contract.js";
export { discoverUnits } from "./discovery.js";
export { collectClientFieldAccesses } from "./field-accesses.js";
export { parseConditionExpression } from "./predicates.js";
export { createTsSubUnitContext } from "./sub-unit-context.js";
export { resolveSubject } from "./subjects.js";
export { findTerminals } from "./terminals.js";

export type {
  TypeScriptAdapter,
  TypeScriptAdapterConfig,
} from "./adapter.js";
export type { FunctionRoot } from "./conditions.js";
export type { ContractReadResult } from "./contract.js";
export type { ClientCallSite, DiscoveredUnit } from "./discovery.js";
export type {
  TsJsxAttributeLocation,
  TsSubUnitContext,
} from "./sub-unit-context.js";
export type { FoundTerminal } from "./terminals.js";
export type { Timer, TimingReport } from "./timing.js";
