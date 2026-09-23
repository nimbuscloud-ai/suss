// The values the shipped graphql-ruby pack supplies. The adapter's own source
// contains none of these strings, so a test that passes proves the pack drives it.

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
