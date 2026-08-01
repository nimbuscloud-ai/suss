// Stand-in for the module graphql-codegen's client preset generates.
// The generated `gql` is a function, not a tag, and it lives in the
// project rather than in a library, which is why a pack cannot name the
// module it comes from.

export function gql(source: string): unknown {
  return { source };
}

export function graphql(source: string): unknown {
  return { source };
}
