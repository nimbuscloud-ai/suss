// @suss/recognize: write a pack as data, and let any adapter run it.

export { compile } from "./compile.js";
export { examplesMissing, runExamples } from "./example.js";
export { constructedFrom, declaredBy, opsIn } from "./ops.js";
export { pack } from "./pack.js";
export { storageCalls } from "./storage.js";

// A declared pack imports its whole surface from here, including the
// type the adapters load it as.
export type {
  DeclaredMatch,
  PackDeclarations,
  PatternPack,
} from "@suss/extractor";
export type {
  AccessKind,
  ArgumentPick,
  ArgumentsFrom,
  CallStep,
  Chain,
  ContainerArgument,
  ContainerLink,
  ContainerRule,
  Ending,
  FromReceiver,
  KindAsAsked,
  Link,
  LinkFunction,
  MatchStart,
  MethodsLink,
  OneArgument,
  StartLink,
  StorageEnding,
  StorageMethod,
  SubjectLink,
  ToArgument,
  ToReceiver,
} from "./chain.js";
export type { RanExample, RunOverCode } from "./example.js";
export type {
  CallOps,
  ConstructedFrom,
  DeclaredBy,
  OpsCarrier,
  ReceiverOrigin,
  UnsettledName,
} from "./ops.js";
export type { PackSpec } from "./pack.js";
export type { StorageCalls, StorageCallsSpec } from "./storage.js";
