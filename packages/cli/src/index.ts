// @suss/cli — public exports. The bin entry lives in bin.ts so importing
// this module is side-effect free.

export { check, checkDir } from "./check.js";
export { contract } from "./contract.js";
export { extract } from "./extract.js";
export { inspect, inspectDiff, inspectDir } from "./inspect.js";
export { runCli, USAGE } from "./run.js";

export type {
  CheckDirOptions,
  CheckOptions,
  CheckResult,
  FailOn,
} from "./check.js";
export type { ContractOptions, ContractSource } from "./contract.js";
export type { ExtractOptions } from "./extract.js";
export type { DiffOptions, DirOptions, InspectOptions } from "./inspect.js";
