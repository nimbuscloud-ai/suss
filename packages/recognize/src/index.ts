// @suss/recognize: write a pack as data, and let any adapter run it.

export { callbacks } from "./callbacks.js";
export { compile } from "./compile.js";
export { configuredSends } from "./configuredSends.js";
export { discoverDeclared } from "./discovery.js";
export { examplesMissing, runExamples } from "./example.js";
export { messageSends } from "./messageSends.js";
export {
  allOf,
  anyOf,
  constructedFrom,
  declaredBy,
  global,
  handedBy,
  handedIn,
  imported,
  inherits,
  opsIn,
  readIn,
  readOff,
  returnedBy,
  typed,
} from "./ops.js";
export {
  declarationsIn,
  describeDiscovery,
  pack,
  subUnitsOf,
} from "./pack.js";
export { runtimeReads } from "./runtimeReads.js";
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
  ArgumentPosition,
  ArgumentsFrom,
  CallbackAnyArgument,
  CallbackArgument,
  CallbackBlock,
  CallbackMethod,
  CallbackPick,
  CallbackProperty,
  CalleeLeaf,
  CalleeSpelling,
  CallStep,
  CallsLink,
  Chain,
  ChannelPart,
  ClaimMetadata,
  ClaimMetadataLeaf,
  ConfigEntry,
  ContainerArgument,
  ContainerLink,
  ContainerMember,
  ContainerRule,
  ContainersLink,
  DeclaredSlots,
  Deployment,
  Ending,
  EntriesLink,
  EntryMeaning,
  FallbackPick,
  FieldsReadPick,
  FromReceiver,
  GetterMeaning,
  GettersLink,
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
  MetadataEntry,
  MethodMeaning,
  MethodsLink,
  NamesStated,
  Naming,
  NoEntry,
  OffLink,
  OneArgument,
  OneMessage,
  ProjectSystem,
  PropertyPart,
  RelatedAccess,
  RelationsLink,
  RuntimeReadEnding,
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
  ThroughHelpersLink,
  ToArgument,
  ToChained,
  ToMember,
  ToReceiver,
  UnitInvokeEnding,
  UnitInvokeMethod,
  UnitWhenInPlaceLink,
  WholeMessage,
  WriteMeaning,
  WritesLink,
} from "./chain.js";
export type { CompileOptions } from "./compile.js";
export type { ConfiguredCallSpec } from "./configuredSends.js";
export type { DeclaredUnit } from "./discovery.js";
export type { RanExample, RunOverCode } from "./example.js";
export type { MessageSends, MessageSendsSpec } from "./messageSends.js";
export type {
  AllOf,
  AnyOf,
  CallOps,
  ClassOps,
  ConstructedFrom,
  DeclaredBy,
  Global,
  HandedBy,
  HandedIn,
  Imported,
  Inheriting,
  Inherits,
  OpsCarrier,
  ReadOff,
  ReadOps,
  ReadOpsCarrier,
  ReceiverOrigin,
  ReturnedBy,
  RuntimeObject,
  SuppliedKey,
  Typed,
  UnsettledName,
  ValueEntry,
  ValueOps,
} from "./ops.js";
export type { Match, PackSpec } from "./pack.js";
export type {
  ReadMeaning,
  RuntimeReads,
  RuntimeReadsSpec,
} from "./runtimeReads.js";
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
