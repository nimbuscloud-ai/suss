// pack.ts: the Ruby adapter's own pattern-pack contract.
//
// Not the TypeScript adapter's `PatternPack`, and shaped differently
// from the Python adapter's `PythonPack` too: Ruby's discovery shape
// (a class whose superclass names a library base class, scanned for
// DSL calls in its body) has no exact match in either. Per the
// language-adapters proposal's invariant, match shapes stay
// per-language until a second implementation shows what's shared. A
// pack is still plain data, the same discipline the Python and
// TypeScript packs follow: naming what a library defines, nothing a
// project chose. Every call name, keyword, scalar, and naming
// convention below is a value the pack supplies, so this package never
// hardcodes another library's vocabulary.

import type { TypeShape } from "@suss/behavioral-ir";
import type { ConstantPathConvention } from "./constantPath.js";
import type { GraphqlTypeNameConvention } from "./scope.js";

export interface RubyPack {
  name: string;
  /** Wire protocol for the produced boundary bindings, e.g. "http-graphql". */
  protocol: string;
  discovery: RubyDiscoveryPattern[];
}

export type RubyDiscoveryPattern = GraphqlObjectFields;

/**
 * A class whose `< ...` superclass names one of `baseClassNames`
 * declares GraphQL fields through DSL calls in its own body. Which
 * calls and keywords spell that DSL, which scalar names it defines,
 * and which naming conventions it follows are all the library's to
 * state, so every one of them is a field here rather than a constant
 * in the adapter.
 */
export interface GraphqlObjectFields {
  type: "graphqlObjectFields";
  /**
   * Fully-qualified base class names that mark a class as a GraphQL
   * object type. Library-defined: the shipped default names the base
   * class the library itself generates. A project's own intermediate
   * base class does not belong in a shipped default; supply it through
   * pack config instead.
   */
  baseClassNames: string[];
  /**
   * Directory the constant-to-path convention resolves a wiring
   * keyword's referenced class against. Project-supplied: this is a
   * directory layout choice, not something the library names.
   */
  root: string;
  /**
   * Named constant-to-path convention used to locate a wiring
   * keyword's referenced class on disk. Library-defined: the library
   * documents which loading convention its host framework runs. The
   * algorithm itself lives in the adapter (see constantPath.ts); one
   * convention exists today, `railsUnderscore`.
   */
  pathConvention: ConstantPathConvention;
  /**
   * The DSL call declaring one schema field in an object type's body.
   * Library-defined: the call is the library's own class-level method.
   */
  fieldCallName: string;
  /**
   * The DSL call declaring a referenced class's own return type (the
   * resolver-class shape). Library-defined.
   */
  typeCallName: string;
  /**
   * The DSL call declaring one named argument. Library-defined.
   */
  argumentCallName: string;
  /**
   * Keywords on a field call whose value names a class the declared
   * contract is read from, one hop away. Library-defined: these are
   * the library's own wiring keywords, tried in the order listed.
   */
  wiringKeywords: string[];
  /**
   * Keyword on an argument call stating whether the argument is
   * required. Library-defined.
   */
  requiredKeyword: string;
  /**
   * What an argument that states no required keyword defaults to.
   * Library-defined: the library's own registration default.
   */
  requiredDefault: boolean;
  /**
   * Keyword on a field or argument call overriding the camelize
   * default for that one name. Library-defined.
   */
  camelizeKeyword: string;
  /**
   * Whether a field/argument symbol's snake_case name is exposed on
   * the schema in camelCase when the call itself doesn't say. The
   * library defines the default; a project that reconfigures it
   * schema-wide supplies its own value through pack config.
   */
  camelizeDefault: boolean;
  /**
   * The library's built-in scalar type names, each mapped to the shape
   * it reads as. Library-defined: only names the library itself
   * accepts in a type position belong here.
   */
  scalars: Record<string, TypeShape>;
  /**
   * Module prefixes under which the same built-in scalars are also
   * reachable when written fully pathed. Library-defined.
   */
  scalarNamePrefixes: string[];
  /**
   * Named convention deriving a GraphQL type name from a class's
   * qualified Ruby name. Library-defined: the library documents its
   * default naming rule. The algorithm itself lives in the adapter
   * (see scope.ts); one convention exists today, `stripTypeSuffix`.
   */
  typeNameConvention: GraphqlTypeNameConvention;
}
