// @suss/adapter-ruby: the Ruby language adapter.
//
// Layer 1 for Ruby, per docs/internal/facts-and-rules.md: discover
// units, emit summaries in the shared IR, emit facts. Everything above
// that layer (reachability, cross-boundary checking, the CLI) is
// already language-independent and comes along unchanged once a
// summary carries a `BoundaryBinding`, the same contract the Python and
// TypeScript adapters meet.
//
// See docs/internal/proposals/language-adapters.md for what this slice
// covers and what it deliberately doesn't: a class-DSL field pattern
// only, no route-file macro expansion, no path-engine lowering (so a
// field's transitions are always empty), no `require` resolution beyond
// class/module nesting. Which library's DSL is being read is entirely
// the pack's statement: every call name, keyword, scalar, and naming
// convention arrives through `GraphqlObjectFields` (see pack.ts).

export {
  resolveConstantFile,
  underscoreConstantPath,
} from "./constantPath.js";
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
} from "./scope.js";
export { typeShapeFromNode } from "./typeShape.js";

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
