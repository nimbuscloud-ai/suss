// @suss/adapter-typescript — Phase 2 exports

export {
  createTypeScriptAdapter,
  extractCodeStructure,
} from "./adapter.js";
export { extractRawBranches } from "./assembly.js";
export { collectAncestorBranches, collectEarlyReturns } from "./conditions.js";
export { readContract } from "./contract.js";
export { discoverUnits } from "./discovery.js";
export { parseConditionExpression } from "./predicates.js";
export { resolveSubject } from "./subjects.js";
export { findTerminals } from "./terminals.js";

export type {
  TypeScriptAdapter,
  TypeScriptAdapterConfig,
} from "./adapter.js";
export type { ContractReadResult } from "./contract.js";
export type { DiscoveredUnit } from "./discovery.js";
export type { FoundTerminal } from "./terminals.js";
