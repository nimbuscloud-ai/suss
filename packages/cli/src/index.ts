// @suss/cli: public exports. The bin entry lives in bin.ts so importing
// this module is side-effect free.

export { type AskOptions, answerQuestion, ask } from "./ask.js";
export { check, checkDir, checkDirectory } from "./check.js";
export { type CheckAtOptions, type CheckAtResult, checkAt } from "./checkAt.js";
export { contract } from "./contract.js";
export { type CorroborateOptions, corroborateSummary } from "./corroborate.js";
export {
  type CorroborateCommandOptions,
  type CorroborateResult,
  corroborate,
} from "./corroborateCommand.js";
export { extract } from "./extract.js";
export { inspect, inspectDiff, inspectDir } from "./inspect.js";
export {
  type DraftedIntent,
  type IntentDraftOptions,
  type IntentDraftResult,
  intentDraft,
  intentDraftResult,
  type UndraftedBoundary,
} from "./intentDraftCommand.js";
export { LANGUAGES, type Language } from "./language.js";
export { runCli, USAGE } from "./run.js";
export {
  draftYaml,
  type StubDraftOptions,
  type StubDraftResult,
  stubDraft,
  stubDraftResult,
} from "./stubDraftCommand.js";
export { loadStubs, type StubFile, stubOverlayOf } from "./stubs.js";

export type { Answer, AnswerJson, QuestionShape } from "./ask.js";
export type {
  CheckDirOptions,
  CheckOptions,
  CheckResult,
  FailOn,
} from "./check.js";
export type { ContractOptions, ContractSource } from "./contract.js";
export type { ExtractOptions } from "./extract.js";
export type { DiffOptions, DirOptions, InspectOptions } from "./inspect.js";
export type {
  ResolvedTarget,
  TargetKind,
  TargetResolution,
} from "./target.js";
