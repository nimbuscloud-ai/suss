// @suss/recognize: write a pack as data, and let any adapter run it.

export { callbackPositions, callbacks } from "./callbacks.js";
export {
  association,
  callback,
  classBody,
  declareClassBodies,
  declareClassBody,
  definesMethod,
} from "./classBody.js";
export { callbackHandedOver, compile } from "./compile.js";
export { readSpellingsOf, siteReadOf } from "./compileReads.js";
export { configuredSends } from "./configuredSends.js";
export { discoverDeclared, discoverEntryObject } from "./discovery.js";
export { examplesMissing, runExamples } from "./example.js";
export { httpRequests, verbs } from "./httpRequests.js";
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
  requestRecognizersOf,
  subUnitsOf,
} from "./pack.js";
export { renderedProps } from "./renderedProps.js";
export {
  composeAppRoutes,
  composeRoutes,
  joinedTablePath,
  rowRoutes,
} from "./routeTable.js";
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
  BaseJoin,
  BaseUrlLink,
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
  CallsReached,
  Chain,
  ChannelPart,
  ClaimInputs,
  ClaimMetadata,
  ClaimMetadataLeaf,
  ClaimsEnding,
  ClassContainer,
  ClassNaming,
  ClassPick,
  ClassSource,
  ColumnsPick,
  ConditionsPick,
  ConfigEntry,
  ContainerArgument,
  ContainerClass,
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
  EntriesBy,
  EntriesLink,
  EntryMeaning,
  Envelope,
  EnvelopeStep,
  FallbackPick,
  FieldsReadPick,
  FromReceiver,
  FunctionsLink,
  GetterMeaning,
  GettersLink,
  HttpRequestEnding,
  InputLink,
  InputRule,
  InterpolatesLink,
  KeysOfPick,
  KeywordArguments,
  KeywordsOfPick,
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
  MissingEntry,
  NamePick,
  NamesStated,
  Naming,
  NoEntry,
  OffLink,
  OneArgument,
  OneMessage,
  OutermostLink,
  ParameterPick,
  ParentLeaf,
  ProjectSystem,
  PropertyPart,
  ReceiverValue,
  RelatedAccess,
  RelationsLink,
  RenderedPropsLink,
  RequestMethod,
  RuntimeReadEnding,
  ScheduleEnding,
  ScheduleUnread,
  SchemaParse,
  ScopeLink,
  SelectorParamPick,
  SentAsNamed,
  SentAsObject,
  SentFromArgument,
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
  ToChainStart,
  ToMember,
  ToPassedTo,
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
export type { ReadSpellings, SiteRead } from "./compileReads.js";
export type { ConfiguredCallSpec } from "./configuredSends.js";
export type { DeclaredUnit, DecoratedBy } from "./discovery.js";
export type { RanExample, RunOverCode } from "./example.js";
export type { HttpRequests, HttpRequestsSpec } from "./httpRequests.js";
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
  CarrierRule,
  ChildrenIn,
  DefaultsRole,
  EntryPick,
  EntrySource,
  ExpandsRole,
  ExpansionRow,
  FragmentRole,
  IncludeRole,
  MountRole,
  ReceiverUnread,
  ReplayRole,
  RootRule,
  RouteGap,
  RouteOutcome,
  RouteRole,
  RouteSet,
  RouteSources,
  RouteTableDeclaration,
  RouteUnread,
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
  StorageCallsOptions,
  StorageCallsSpec,
} from "./storage.js";
export type { StreamWrites, StreamWritesSpec } from "./streamWrites.js";
export type { UnitInvokes, UnitInvokesSpec } from "./unitInvokes.js";
