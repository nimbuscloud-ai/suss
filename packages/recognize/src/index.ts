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
  ArgumentPick,
  Chain,
  ContainerLink,
  Ending,
  FromReceiver,
  Link,
  LinkFunction,
  MatchStart,
  MethodsLink,
  StartLink,
  StorageEnding,
  StorageMethod,
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
