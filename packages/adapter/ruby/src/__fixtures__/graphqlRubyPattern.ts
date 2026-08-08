// Shared test construction: a fully-populated `graphqlObjectFields`
// pattern carrying graphql-ruby's vocabulary, the same values the
// shipped @suss/framework-graphql-ruby pack supplies. The adapter's own
// source never names these; tests supply them here the way a pack
// would, overriding only what each test exercises.

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
