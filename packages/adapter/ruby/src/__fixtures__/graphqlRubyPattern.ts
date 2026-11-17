// The values the shipped graphql-ruby pack supplies. The adapter's own source
// contains none of these strings, so a test that passes proves the pack drives it.

import { rubyConstants } from "@suss/recognize";

import type { TypeShape } from "@suss/behavioral-ir";
import type { SubclassOfMatch } from "@suss/extractor";
import type { GraphqlObjectFields, RubyPack } from "../pack.js";

/** graphql-ruby's object types and fields, as the pack declares them, for these bases. */
export function graphqlFields(
  bases: readonly string[] = ["Types::BaseObject"],
  camelize = true,
): SubclassOfMatch {
  return {
    type: "subclassOf",
    inherits: rubyConstants(...bases),
    skipClasses: bases,
    members: { kind: "instance", names: [] },
    className: { call: "graphql_name", suffixRemoved: "Type" },
    calls: {
      field: {
        name: { at: 0 },
        naming: { camel: { keyword: "camelize", default: camelize } },
        runs: [
          { classAt: { keyword: "mutation" }, method: "resolve" },
          { classAt: { keyword: "resolver" }, method: "resolve" },
          { method: { keyword: "resolver_method" } },
          { method: "named" },
        ],
      },
    },
  };
}

export function graphqlObjectFieldsPattern(
  overrides: Partial<GraphqlObjectFields> = {},
): GraphqlObjectFields {
  return {
    type: "graphqlObjectFields",
    fields: graphqlFields(),
    root: "/app/graphql",
    pathConvention: "railsUnderscore",
    fieldCallName: "field",
    typeCallName: "type",
    argumentCallName: "argument",
    resolverMethodName: "resolve",
    resolverHooks: {
      methods: ["ready?", "authorized?"],
      answerIsListHead: true,
    },
    ancestryRootClassNames: [
      "GraphQL::Schema::Object",
      "GraphQL::Schema::Mutation",
      "GraphQL::Schema::RelayClassicMutation",
      "GraphQL::Schema::Resolver",
    ],
    requiredKeyword: "required",
    requiredDefault: true,
    camelizeKeyword: "camelize",
    camelizeDefault: true,
    scalars: {
      String: { type: "text" },
      ID: { type: "text" },
      Int: { type: "number" },
      Float: { type: "number" },
      Boolean: { type: "boolean" },
      Integer: { type: "number" },
    },
    scalarNamePrefixes: ["GraphQL::Types::"],
    typeNameConvention: "stripTypeSuffix",
    argumentWrapping: {
      ancestorClassName: "GraphQL::Schema::RelayClassicMutation",
      argumentName: "input",
      extraFields: {
        clientMutationId: { type: { type: "text" }, required: false },
      },
    },
    ...overrides,
  };
}

const orNull = (shape: TypeShape): TypeShape => ({
  type: "union",
  variants: [shape, { type: "null" }],
});

/** What the shipped pack says about a field's output: null, type names, generated types and errors. */
export const GRAPHQL_OUTPUT_OPTIONS: Partial<GraphqlObjectFields> = {
  typeKeyword: "type",
  typeNameCallName: "graphql_name",
  nullability: {
    keyword: "null",
    callName: "null",
    nullableByDefault: true,
    listItemsNullableByDefault: false,
  },
  typeWrappers: {
    connection_type: {
      name: "{type}Connection",
      types: {
        "{type}Connection": {
          nodes: orNull({
            type: "array",
            items: orNull({ type: "ref", name: "{type}" }),
          }),
          edges: orNull({
            type: "array",
            items: orNull({ type: "ref", name: "{type}Edge" }),
          }),
          pageInfo: { type: "ref", name: "PageInfo" },
        },
        "{type}Edge": {
          cursor: { type: "text" },
          node: orNull({ type: "ref", name: "{type}" }),
        },
      },
    },
    collection_type: {
      name: "{type}Collection",
      types: {
        "{type}Collection": {
          collection: { type: "array", items: { type: "ref", name: "{type}" } },
          metadata: { type: "ref", name: "{metadata_type}" },
        },
      },
      typeArguments: {
        "{metadata_type}": {
          keyword: "metadata_type",
          fallback: "CollectionMetadata",
        },
      },
    },
  },
  libraryTypes: {
    PageInfo: { hasNextPage: { type: "boolean" } },
    CollectionMetadata: { totalCount: { type: "number" } },
  },
  returnedErrorClassNames: ["GraphQL::ExecutionError"],
  resolverHooks: {
    methods: ["ready?", "authorized?"],
    answerIsListHead: true,
    refusalRaises: { "authorized?": "GraphQL::UnauthorizedFieldError" },
  },
};

export function graphqlRubyTestPack(
  overrides: Partial<GraphqlObjectFields> = {},
): RubyPack {
  return {
    name: "graphql-ruby",
    protocol: "http-graphql",
    discovery: [graphqlObjectFieldsPattern(overrides)],
  };
}
