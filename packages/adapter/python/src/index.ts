// @suss/adapter-python: the Python language adapter.
//
// This is Layer 1 for Python. It discovers units, emits summaries in
// the shared IR, and emits facts. Everything above that layer, meaning
// reachability, cross-boundary checking and the CLI, is already
// independent of language and works unchanged as soon as a summary
// comes with a `BoundaryBinding`. That is the same contract the
// TypeScript adapter meets.
//
// This slice does no path-engine lowering, so a route's transitions are
// either empty or a single declared-shape transition, never a
// decomposed branch. It infers nothing, and it never executes Python.

export { annotationToShape, shapeFromName } from "./annotations.js";
export { classifyDecorator } from "./decorators.js";
export { discoverUnits } from "./discovery.js";
export {
  containedValues,
  objectReturnedBy,
  resolveCalls,
} from "./facts/resolve.js";
export { emitValueFacts, nodeId, readKey } from "./facts/values.js";
export { PythonWhySession } from "./facts/why.js";
export { emitEntryFact, emitModuleImportFacts, unitKey } from "./facts.js";
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
export { extractPythonProject, findPythonFiles } from "./project.js";
export { buildRouterIndex } from "./routers.js";
export { bindModule, resolveName } from "./scope.js";
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
  PyStatusCall,
  PythonDiscoveryPattern,
  PythonPack,
  RawSqlPattern,
  RouteConventions,
  RouterComposition,
  StoragePattern,
} from "./pack.js";
export type { PyNode, PyTree } from "./parser.js";
export type { ExtractPythonOptions, ExtractPythonResult } from "./project.js";
export type {
  BoundPythonFile,
  RoutePrefixResolution,
  RouterIndex,
} from "./routers.js";
export type { Binding, ModuleBinding, Scope, ScopeKind } from "./scope.js";
export type {
  PythonImportEvidence,
  PythonImportEvidenceOptions,
  PythonImportSite,
} from "./stubEvidence.js";
