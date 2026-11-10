// @suss/recognize: write a pack as data, and let any adapter run it.

export { callbacks } from "./callbacks.js";
export { compile } from "./compile.js";
export { configuredSends } from "./configuredSends.js";
export { discoverDeclared } from "./discovery.js";
export { examplesMissing, runExamples } from "./example.js";
export { messageSends } from "./messageSends.js";
export {
  anyOf,
  constructedFrom,
  declaredBy,
  global,
  handedBy,
  imported,
  inherits,
  opsIn,
  returnedBy,
  typed,
} from "./ops.js";
export { declarationsIn, describeDiscovery, pack } from "./pack.js";
export { slotsDeclared } from "./slots.js";
export { sqlStatements } from "./sqlStatements.js";
export { storageCalls } from "./storage.js";
export { streamWrites } from "./streamWrites.js";
export { unitInvokes } from "./unitInvokes.js";

// A declared pack imports its whole surface from here, including the
// type the adapters load it as.
export type {
  DeclaredMatch,
  HelperDeclarations,
  HelperSink,
  HelperValue,
  PackDeclarations,
  PatternPack,
  ProjectHelper,
  ProjectHelpers,
} from "@suss/extractor";
export type { Callbacks, CallbacksSpec } from "./callbacks.js";
export type {
  AccessKind,
  AccessPathLink,
  ArgumentBody,
  ArgumentPart,
  ArgumentPick,
  ArgumentsFrom,
  CallbackArgument,
  CallbackBlock,
  CallbackMethod,
  CallbackPick,
  CallbackProperty,
  CallStep,
  CallsLink,
  Chain,
  ChannelPart,
  ContainerArgument,
  ContainerLink,
  ContainerMember,
  ContainerRule,
  ContainersLink,
  DeclaredSlots,
  Ending,
  FieldsReadPick,
  FromReceiver,
  InputLink,
  InputRule,
  InterpolatesLink,
  KeysOfPick,
  KindAsAsked,
  Link,
  LinkFunction,
  ManyAsTheInput,
  ManyIn,
  MatchStart,
  MessageLocation,
  MessageSendEnding,
  MessageSendMethod,
  MethodMeaning,
  MethodsLink,
  NamesStated,
  Naming,
  OneArgument,
  OneMessage,
  ProjectSystem,
  PropertyPart,
  RelatedAccess,
  RelationsLink,
  ScheduleEnding,
  ScheduleUnread,
  ScopeLink,
  SelectorParamPick,
  SlotsLink,
  SqlEnding,
  SqlMethod,
  StartLink,
  StatedInputs,
  StatedRule,
  StorageEnding,
  StorageMethod,
  StorageSystem,
  StreamWriteEnding,
  StreamWriteMethod,
  SubjectLink,
  SubUnitNamePart,
  TheCall,
  ToArgument,
  ToChained,
  ToMember,
  ToReceiver,
  UnitInvokeEnding,
  UnitInvokeMethod,
  UnitWhenInPlaceLink,
  WholeMessage,
} from "./chain.js";
export type { ConfiguredCallSpec } from "./configuredSends.js";
export type { DeclaredUnit } from "./discovery.js";
export type { RanExample, RunOverCode } from "./example.js";
export type { MessageSends, MessageSendsSpec } from "./messageSends.js";
export type {
  AnyOf,
  CallOps,
  ClassOps,
  ConstructedFrom,
  DeclaredBy,
  Global,
  HandedBy,
  Imported,
  Inheriting,
  Inherits,
  OpsCarrier,
  ReceiverOrigin,
  ReturnedBy,
  Typed,
  UnsettledName,
  ValueEntry,
  ValueOps,
} from "./ops.js";
export type { Match, PackSpec } from "./pack.js";
export type { SlotColumns } from "./slots.js";
export type { SqlStatements, SqlStatementsSpec } from "./sqlStatements.js";
export type {
  AboutOptions,
  MemberContainer,
  StorageCalls,
  StorageCallsSpec,
} from "./storage.js";
export type { StreamWrites, StreamWritesSpec } from "./streamWrites.js";
export type { UnitInvokes, UnitInvokesSpec } from "./unitInvokes.js";
