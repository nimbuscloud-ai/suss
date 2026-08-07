// @suss/adapter-python: the Python language adapter.
//
// Layer 1 for Python, per docs/internal/facts-and-rules.md: discover
// units, emit summaries in the shared IR, emit facts. Everything above
// that layer (reachability, cross-boundary checking, the CLI) is
// already language-independent and comes along unchanged once a
// summary carries a `BoundaryBinding`, the same contract the
// TypeScript adapter meets.
//
// See docs/internal/proposals/language-adapters.md for what this slice
// covers and what it deliberately doesn't: no path-engine lowering (so
// a route's transitions are empty or one declared-shape transition,
// never a decomposed branch), no inference, nothing that executes
// Python.

export { annotationToShape, shapeFromName } from "./annotations.js";
export { classifyDecorator } from "./decorators.js";
export { discoverUnits } from "./discovery.js";
export { emitEntryFact, emitModuleImportFacts, unitKey } from "./facts.js";
export {
  resolveAbsoluteModule,
  resolveModule,
  resolveRelativeModule,
} from "./moduleResolver.js";
export { parsePython } from "./parser.js";
export { extractPythonProject, findPythonFiles } from "./project.js";
export { bindModule, resolveName } from "./scope.js";

export type { AnnotationContext } from "./annotations.js";
export type { DecoratorArg, DecoratorClassification } from "./decorators.js";
export type { DiscoveryOptions } from "./discovery.js";
export type {
  ModuleResolution,
  ModuleResolverOptions,
  RelativeModuleSpec,
} from "./moduleResolver.js";
export type {
  DecoratedClassRoute,
  DecoratedFunctionRoute,
  PythonDiscoveryPattern,
  PythonPack,
} from "./pack.js";
export type { PyNode, PyTree } from "./parser.js";
export type { ExtractPythonOptions, ExtractPythonResult } from "./project.js";
export type { Binding, ModuleBinding, Scope, ScopeKind } from "./scope.js";
