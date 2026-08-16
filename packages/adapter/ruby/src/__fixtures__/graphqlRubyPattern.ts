// graphql-ruby's vocabulary, the same values the shipped pack supplies. None of
// these strings appear anywhere in the adapter's own source.

import type { GraphqlObjectFields, RubyPack } from "../pack.js";

export function graphqlObjectFieldsPattern(
  overrides: Partial<GraphqlObjectFields> = {},
): GraphqlObjectFields {
  return {
    type: "graphqlObjectFields",
    baseClassNames: ["Types::BaseObject"],
    root: "/app/graphql",
    pathConvention: "railsUnderscore",
    fieldCallName: "field",
    typeCallName: "type",
    argumentCallName: "argument",
    wiringKeywords: ["mutation", "resolver"],
    resolverMethodName: "resolve",
    ancestryRootClassNames: [
      "GraphQL::Schema::Object",
      "GraphQL::Schema::Mutation",
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

export function graphqlRubyTestPack(
  overrides: Partial<GraphqlObjectFields> = {},
): RubyPack {
  return {
    name: "graphql-ruby",
    protocol: "http-graphql",
    discovery: [graphqlObjectFieldsPattern(overrides)],
  };
}
