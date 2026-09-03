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
export {
  bodyStatements,
  booleanLiteralValue,
  field,
  hashKeySymbolName,
  readCallArgs,
  runStatements,
  stringLiteralValue,
  symbolValue,
} from "./ast.js";
export { resolveConstantFile, underscoreConstantPath } from "./constantPath.js";
export {
  createFileCache,
  type DiscoveryOptions,
  discoverUnits,
  type FileCache,
} from "./discovery.js";
export {
  collectFileConstants,
  emitConstantBindings,
} from "./facts/constants.js";
export { emitValueFacts, nodeId, readKey } from "./facts/values.js";
export { RubyWhySession } from "./facts/why.js";
export { emitEntryFact, unitKey } from "./facts.js";
export {
  parseRuby,
  parseRubySync,
  preloadRubyGrammar,
} from "./parser.js";
export { extractRubyProject, findRubyFiles } from "./project.js";
export {
  graphqlTypeNameFromQualified,
  qualifyConstantRef,
  walkClasses,
  walkDefinitions,
} from "./scope.js";
export { rubyStubEvidence } from "./stubEvidence.js";
export { typeShapeFromNode } from "./typeShape.js";
export {
  ADAPTER_VERSION,
  adapterCodeStamp,
  computeAdapterPacksDigest,
} from "./version.js";

export type {
  AncestorEntry,
  AncestorLookup,
  Ancestry,
  MethodLookup,
  ReachedBody,
} from "./ancestry.js";
export type { CallArgs, Range } from "./ast.js";
export type { ConstantPathConvention } from "./constantPath.js";
export type { FileConstants } from "./facts/constants.js";
export type {
  RubyValueHandle,
  RubyWhySessionOptions,
} from "./facts/why.js";
export type {
  ControllerActions,
  GraphqlObjectFields,
  RbStoragePattern,
  RubyDiscoveryPattern,
  RubyPack,
} from "./pack.js";
export type { RbNode, RbTree } from "./parser.js";
export type { ExtractRubyOptions, ExtractRubyResult } from "./project.js";
export type { ClassInfo, GraphqlTypeNameConvention } from "./scope.js";
export type {
  RubyExtendsSite,
  RubyRequireSite,
  RubyStubEvidence,
  RubyStubEvidenceOptions,
} from "./stubEvidence.js";
export type { TypeReadContext } from "./typeShape.js";
