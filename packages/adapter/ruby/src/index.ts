/**
 * The Ruby language adapter.
 *
 * It discovers units, writes a summary for each one in the shared IR, and
 * emits facts. Reachability, cross-boundary checking and the CLI work on
 * those without knowing the language, once a summary has a
 * `BoundaryBinding`. The Python and TypeScript adapters meet the same
 * contract.
 *
 * The packs supply the call names, keywords and base classes a library
 * defines.
 */

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
  nestedStatements,
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
export {
  extractRubyProject,
  factsForFile,
  findRubyFiles,
} from "./project.js";
export {
  graphqlTypeNameFromQualified,
  qualifyConstantRef,
  walkClasses,
  walkDefinitions,
} from "./scope.js";
export {
  type RbStorageOptions,
  storageClaims,
  storageEffects,
} from "./storage.js";
export { rubyStubEvidence } from "./stubEvidence.js";
export { typeShapeFromNode } from "./typeShape.js";
export {
  bindEvaluator,
  evaluatedValue,
  methodDefinitionsIn,
  type ParameterBindings,
  stringValueOf,
} from "./values/evaluator.js";
export { ADAPTER_VERSION } from "./version.js";

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
  RbAddressingCall,
  RbArgumentPlace,
  RbBodyBlock,
  RbInflections,
  RbRawSqlPattern,
  RbRowCall,
  RbStatusCall,
  RbStoragePattern,
  RubyDiscoveryPattern,
  RubyPack,
} from "./pack.js";
export type { RbNode, RbTree } from "./parser.js";
export type {
  ExtractRubyOptions,
  ExtractRubyResult,
  FileFactsOptions,
} from "./project.js";
export type { ClassInfo, GraphqlTypeNameConvention } from "./scope.js";
export type {
  RubyExtendsSite,
  RubyRequireSite,
  RubyStubEvidence,
  RubyStubEvidenceOptions,
} from "./stubEvidence.js";
export type { TypeReadContext } from "./typeShape.js";
export type { EvaluatedFile, ProjectNodes } from "./values/evaluator.js";
