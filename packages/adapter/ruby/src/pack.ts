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
// project chose.

export interface RubyPack {
  name: string;
  /** Wire protocol for the produced boundary bindings, e.g. "http-graphql". */
  protocol: string;
  discovery: RubyDiscoveryPattern[];
}

export type RubyDiscoveryPattern = GraphqlObjectFields;

/**
 * A class whose `< ...` superclass names one of `baseClassNames`
 * declares GraphQL fields through `field`/`argument`/`type` calls in
 * its own body, read the way graphql-ruby's class DSL declares them.
 * The GraphQL type name comes from the class's own short name (see
 * `graphqlTypeNameFromQualified` in scope.ts); there is no separate
 * "this is the root Query/Mutation type" flag to configure, because
 * that convention already falls out of the same rule (`Types::QueryType`
 * reads as `Query`).
 */
export interface GraphqlObjectFields {
  type: "graphqlObjectFields";
  /**
   * Fully-qualified base class names (as graphql-ruby itself defines
   * them, e.g. `"Types::BaseObject"`) that mark a class as a GraphQL
   * object type. A project's own intermediate base class does not
   * belong in a shipped default; supply it here through pack config
   * instead, the way flask-restx's `wrapperModules` names a project's
   * wrapper alongside the library's own module.
   */
  baseClassNames: string[];
  /**
   * Directory the Rails constant-to-path convention resolves a
   * `mutation:` / `resolver:` field's referenced class against (a
   * project's `app/graphql`, typically). Supplied per project: this is
   * a directory layout choice, not something graphql-ruby names.
   */
  root: string;
  /**
   * graphql-ruby's own default for exposing a `field`/`argument`
   * symbol's snake_case name as camelCase on the schema. Defaults to
   * `true`, the library's own default; a schema that configures
   * `camelize: false` schema-wide sets this to `false`. A `field` or
   * `argument` call's own `camelize:` keyword overrides this default
   * for that one name regardless of which way this is set.
   */
  camelize?: boolean;
}
