/**
 * The Ruby adapter's own pattern-pack contract.
 *
 * Match shapes stay per-language until a second implementation shows what is
 * actually shared, so this is Ruby's own and not the TypeScript or Python
 * adapter's. Everything a library defines, meaning its call names, keywords,
 * scalars, and conventions, arrives as pack data and is never hardcoded here.
 */

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

/** A class whose `< ...` superclass is one of `baseClassNames` declares GraphQL fields through DSL calls in its own body. */
export interface GraphqlObjectFields {
  type: "graphqlObjectFields";
  /** The base class the library itself generates. A project's own intermediate base class is added through pack config. */
  baseClassNames: string[];
  /** The directory a wiring keyword's referenced class is looked up under. That is the project's own layout, not the library's. */
  root: string;
  pathConvention: ConstantPathConvention;
  /** The DSL call declaring one schema field in an object type's body. */
  fieldCallName: string;
  /** The DSL call declaring a referenced class's own return type. */
  typeCallName: string;
  argumentCallName: string;
  /** Keywords whose value gives a class to read the declared contract from, one hop away. They are tried in the order listed. */
  wiringKeywords: string[];
  /** The method a wired class defines to resolve the field it is wired to. Library-defined. */
  resolverMethodName: string;
  /** The library's own classes that a project's class chain ends at. Library-defined. */
  ancestryRootClassNames: string[];
  /** Keyword on an argument call saying whether the argument is required. Library-defined. */
  requiredKeyword: string;
  /** What an argument means when it does not write the required keyword at all. */
  requiredDefault: boolean;
  /** The keyword that overrides `camelizeDefault` for a single name. */
  camelizeKeyword: string;
  /** Whether a symbol's snake_case name is exposed camelCased when the call itself does not say. */
  camelizeDefault: boolean;
  /** Only the names the library itself accepts in a type position belong here. */
  scalars: Record<string, TypeShape>;
  /** Module prefixes the same scalars can also be written under when someone spells out the full path. */
  scalarNamePrefixes: string[];
  typeNameConvention: GraphqlTypeNameConvention;
}
