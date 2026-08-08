// @suss/adapter-ruby: the Ruby language adapter.
//
// This is Layer 1 for Ruby. It discovers units, emits summaries in the
// shared IR, and emits facts. Everything above that layer, meaning
// reachability, cross-boundary checking and the CLI, is already
// independent of language and works unchanged as soon as a summary
// comes with a `BoundaryBinding`. That is the same contract the Python
// and TypeScript adapters meet.
//
// This slice reads a class-based field DSL and nothing else. It does
// not expand route-file macros, it does no path-engine lowering, so a
// field's transitions are always empty, and it resolves no `require`
// beyond class and module nesting.
//
// Which library's DSL gets read is entirely up to the pack. Every call
// name, keyword, scalar and naming convention arrives through
// `GraphqlObjectFields`.

export {
  ancestryOf,
  inheritedStatements,
  methodInAncestry,
  reachDefinition,
} from "./ancestry.js";
export { resolveConstantFile, underscoreConstantPath } from "./constantPath.js";
export {
  createFileCache,
  type DiscoveryOptions,
  discoverUnits,
  type FileCache,
} from "./discovery.js";
export { emitEntryFact, unitKey } from "./facts.js";
export { parseRuby } from "./parser.js";
export { extractRubyProject, findRubyFiles } from "./project.js";
export {
  graphqlTypeNameFromQualified,
  qualifyConstantRef,
  walkClasses,
  walkDefinitions,
} from "./scope.js";
export { typeShapeFromNode } from "./typeShape.js";

export type {
  AncestorEntry,
  AncestorLookup,
  Ancestry,
  MethodLookup,
  ReachedBody,
} from "./ancestry.js";
export type { ConstantPathConvention } from "./constantPath.js";
export type {
  GraphqlObjectFields,
  RubyDiscoveryPattern,
  RubyPack,
} from "./pack.js";
export type { RbNode, RbTree } from "./parser.js";
export type { ExtractRubyOptions, ExtractRubyResult } from "./project.js";
export type { ClassInfo, GraphqlTypeNameConvention } from "./scope.js";
export type { TypeReadContext } from "./typeShape.js";
