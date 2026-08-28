// @suss/recognize: write a pack as data, and let any adapter run it.

export { compile } from "./compile.js";
export { examplesMissing, runExamples } from "./example.js";
export { messageSends } from "./messageSends.js";
export { constructedFrom, declaredBy, opsIn } from "./ops.js";
export { declarationsIn, pack } from "./pack.js";
export { sqlStatements } from "./sqlStatements.js";
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
  AccessPathLink,
  ArgumentPick,
  ArgumentsFrom,
  CallStep,
  CallsLink,
  Chain,
  ChannelPart,
  ContainerArgument,
  ContainerLink,
  ContainerRule,
  ContainersLink,
  Ending,
  FromReceiver,
  InputLink,
  InputRule,
  InterpolatesLink,
  KindAsAsked,
  Link,
  LinkFunction,
  ManyIn,
  MatchStart,
  MessageLocation,
  MessageSendEnding,
  MessageSendMethod,
  MethodMeaning,
  MethodsLink,
  OneArgument,
  OneMessage,
  SelectorParamPick,
  SqlEnding,
  SqlMethod,
  StartLink,
  StatedInputs,
  StatedRule,
  StorageEnding,
  StorageMethod,
  SubjectLink,
  ToArgument,
  ToReceiver,
} from "./chain.js";
export type { RanExample, RunOverCode } from "./example.js";
export type { MessageSends, MessageSendsSpec } from "./messageSends.js";
export type {
  CallOps,
  ConstructedFrom,
  DeclaredBy,
  OpsCarrier,
  ReceiverOrigin,
  UnsettledName,
  ValueEntry,
  ValueOps,
} from "./ops.js";
export type { Match, PackSpec } from "./pack.js";
export type { SqlStatements, SqlStatementsSpec } from "./sqlStatements.js";
export type { StorageCalls, StorageCallsSpec } from "./storage.js";
