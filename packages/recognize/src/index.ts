// @suss/recognize: write a pack as data, and let any adapter run it.

export { callbacks } from "./callbacks.js";
export {
  association,
  callback,
  classBody,
  declareClassBodies,
  declareClassBody,
  definesMethod,
} from "./classBody.js";
export { compile } from "./compile.js";
export { configuredSends } from "./configuredSends.js";
export { discoverDeclared, discoverEntryObject } from "./discovery.js";
export { examplesMissing, runExamples } from "./example.js";
export { messageReceives } from "./messageReceives.js";
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
export { renderedProps } from "./renderedProps.js";
export { composeRoutes, rowRoutes } from "./routeTable.js";
export { runtimeReads } from "./runtimeReads.js";
export { schemaReads } from "./schemaReads.js";
export { slotsDeclared } from "./slots.js";
export { sqlStatements } from "./sqlStatements.js";
export { storageCalls } from "./storage.js";
export { streamWrites } from "./streamWrites.js";
export { unitInvokes } from "./unitInvokes.js";

// A declared pack imports its whole surface from here, including the
// type the adapters load it as.
export type {
  ClassBodyDeclaration,
  DeclaredMatch,
  EntryMember,
  EntryObject,
  EntryObjectMatch,
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
  ArgumentItemsLeaf,
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
  ClaimInputs,
  ClaimMetadata,
  ClaimMetadataLeaf,
  ClaimsEnding,
  ConfigEntry,
  ContainerArgument,
  ContainerLink,
  ContainerMember,
  ContainerRule,
  ContainersLink,
  CountLeaf,
  DeclaredSlots,
  DefaultedWhenLink,
  Deployment,
  ElementNamePart,
  Ending,
  EntriesLink,
  EntryMeaning,
  Envelope,
  EnvelopeStep,
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
  MessageReceiveEnding,
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
  ParentLeaf,
  ProjectSystem,
  PropertyPart,
  RelatedAccess,
  RelationsLink,
  RenderedPropsLink,
  RuntimeReadEnding,
  ScheduleEnding,
  ScheduleUnread,
  SchemaParse,
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
  TextLeaf,
  TheCall,
  ThroughHelpersLink,
  ToArgument,
  ToBuilder,
  ToChained,
  ToMember,
  ToReceiver,
  UnitInvokeEnding,
  UnitInvokeMethod,
  UnitWhenInPlaceLink,
  UnitWhenNamedInParentLink,
  WholeMessage,
  WriteMeaning,
  WritesLink,
} from "./chain.js";
export type { AssociationTarget, ClassDeclaration } from "./classBody.js";
export type { CompileOptions } from "./compile.js";
export type { ConfiguredCallSpec } from "./configuredSends.js";
export type { DeclaredUnit } from "./discovery.js";
export type { RanExample, RunOverCode } from "./example.js";
export type {
  MessageReceives,
  MessageReceivesSpec,
} from "./messageReceives.js";
export type { MessageSends, MessageSendsSpec } from "./messageSends.js";
export type {
  AllOf,
  AnyOf,
  CallOps,
  CallsAndOptions,
  ClassOps,
  ConstructedFrom,
  Declaration,
  DeclaredBy,
  Decoded,
  ElementOps,
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
  ValueRead,
} from "./ops.js";
export type { Match, PackSpec } from "./pack.js";
export type { ClaimSpec, RenderedProps } from "./renderedProps.js";
export type {
  BaseRole,
  ChildrenIn,
  DefaultsRole,
  EntryPick,
  ExpandsRole,
  ExpansionRow,
  FragmentRole,
  IncludeRole,
  MountRole,
  ReplayRole,
  RootRule,
  RouteGap,
  RouteRole,
  RouteSet,
  RouteSources,
  RouteTableDeclaration,
  ScopesRole,
  ServesRole,
  TableOwner,
  TableRoute,
} from "./routeTable.js";
export type {
  ReadMeaning,
  RuntimeReads,
  RuntimeReadsSpec,
} from "./runtimeReads.js";
export type { SchemaReads, SchemaReadsSpec } from "./schemaReads.js";
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
