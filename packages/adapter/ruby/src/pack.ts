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
  /** What the library's own database calls look like. The README says how one is matched. */
  storage?: RbStoragePattern[];
}

/**
 * Ruby writes no return type, so a call is matched by what its receiver
 * inherits from. A model is a class that reaches one of these base classes,
 * whether the project declares an intermediate one or not.
 */
export interface RbStoragePattern {
  /** Base classes the library gives a model, `ActiveRecord::Base` for Rails. */
  baseClasses: string[];
  /** Methods that change what is stored. Anything else reads. */
  writes: string[];
  /** Which database is behind the connection, which the project settles. */
  storageSystem: "postgresql" | "mysql" | "sqlite";
}

export type RubyDiscoveryPattern = GraphqlObjectFields | ControllerActions;

/** A class whose ancestry reaches one of `baseClassNames` is a controller, and every instance method it defines directly is one of its actions, bound by `routeFor` to the method and path a project's own routing gives it, or discovered with no boundary binding when `routeFor` finds none. */
export interface ControllerActions {
  type: "controllerActions";
  /** The library's own base a project's controllers extend, `ActionController::Base` say. */
  baseClassNames: string[];
  /** The directory a bare superclass name is looked up under, the project's own layout. */
  root: string;
  pathConvention: ConstantPathConvention;
  /** The library's own classes a project's controller chain ends at. */
  ancestryRootClassNames: string[];
  /** Status code a wire response gets when the action does not say otherwise. */
  defaultStatusCode: number;
  /** Absolute path of the file this pattern's own routing came from, for the one gap `drainRoutingGaps` may report. */
  routesFile: string;
  /** The method and path a project's own routing gives one controller's action, or null when that action has none. */
  routeFor: (
    controllerQualifiedName: string,
    actionName: string,
  ) => { method: string; path: string } | null;
  /** One message per routing declaration kind this pattern's reading left uncovered, returned once for the whole run and an empty array after. */
  drainRoutingGaps?: () => readonly string[];
}

/** A class or module whose ancestry reaches one of `baseClassNames` declares GraphQL fields through DSL calls in its own body. */
export interface GraphqlObjectFields {
  type: "graphqlObjectFields";
  /** The base classes the library itself generates. The walk crosses a project's own intermediate bases on its own, so config only has to add a base with another name. */
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
  /**
   * A base class that changes a mutation's wire contract. When a wired
   * class's ancestry reaches `ancestorClassName`, the library wraps
   * every declared argument into one input-object argument called
   * `argumentName` and adds `extraFields` to it. graphql-ruby's
   * RelayClassicMutation is the class this describes: on the wire the
   * mutation takes a single required `input`, whose fields are the
   * declared arguments plus an optional `clientMutationId`.
   */
  argumentWrapping?: {
    ancestorClassName: string;
    argumentName: string;
    extraFields: Record<string, { type: TypeShape; required: boolean }>;
  };
}
