/**
 * The Python language adapter. It discovers units, writes summaries in
 * the shared IR, and records facts for the shared rules.
 *
 * Reachability, checking across a boundary and the CLI do not depend on
 * the language. They work on a Python summary as soon as it has a
 * `BoundaryBinding`, the same as they do on a TypeScript one.
 *
 * A body is lowered into the shared path engine, so a route gets one
 * transition for each place it returns or raises. The adapter reads the
 * source and never runs Python.
 */

export { annotationToShape, shapeFromName } from "./annotations.js";
export { classifyDecorator } from "./decorators.js";
export { discoverUnits } from "./discovery.js";
export {
  containedValues,
  objectReturnedBy,
  resolveCalls,
} from "./facts/resolve.js";
export { emitValueFacts, nameKeyIn, nodeId, readKey } from "./facts/values.js";
export { PythonWhySession } from "./facts/why.js";
export { emitModuleImportFacts } from "./facts.js";
export {
  resolveAbsoluteModule,
  resolveModule,
  resolveRelativeModule,
} from "./moduleResolver.js";
export {
  parsePython,
  parsePythonSync,
  preloadPythonGrammar,
} from "./parser.js";
export {
  extractPythonProject,
  factsForFile,
  findPythonFiles,
} from "./project.js";
export { buildRouterIndex } from "./routers.js";
export { bindModule, resolveName } from "./scope.js";
export { pythonSourceRoots, readTomlFile, tableAt } from "./sourceRoots.js";
export { pythonImportEvidence } from "./stubEvidence.js";
export { ADAPTER_VERSION } from "./version.js";

export type { AnnotationContext } from "./annotations.js";
export type { DecoratorArg, DecoratorClassification } from "./decorators.js";
export type { DiscoveryOptions } from "./discovery.js";
export type {
  PythonValueHandle,
  PythonWhySessionOptions,
} from "./facts/why.js";
export type {
  ModuleResolution,
  ModuleResolverOptions,
  RelativeModuleSpec,
} from "./moduleResolver.js";
export type {
  DecoratedClassRoute,
  DecoratedFunctionRoute,
  MountObjectCarrier,
  MountObjectPrefix,
  MountPrefixEffect,
  NoValuePrefix,
  PathRepeatedSlashes,
  PrefixTrailingSlash,
  PyModelEntryFunction,
  PyModelEntryMethod,
  PyModelQueries,
  PyStatusCall,
  PythonDiscoveryPattern,
  PythonPack,
  RawSqlPattern,
  RouteConventions,
  RouterComposition,
  SqlCallArgument,
  SqlClientHandoff,
  SqlClientPattern,
  SqlStatementCall,
  SqlTableCall,
  StoragePattern,
} from "./pack.js";
export type { PyNode, PyTree } from "./parser.js";
export type {
  ExtractPythonOptions,
  ExtractPythonResult,
  FileFactsOptions,
} from "./project.js";
export type {
  BoundPythonFile,
  RoutePrefixResolution,
  RouterIndex,
} from "./routers.js";
export type { Binding, ModuleBinding, Scope, ScopeKind } from "./scope.js";
export type {
  PythonSourceRoots,
  TomlFileRead,
  TomlTable,
  UnreadManifest,
} from "./sourceRoots.js";
export type {
  PythonImportEvidence,
  PythonImportEvidenceOptions,
  PythonImportSite,
} from "./stubEvidence.js";
