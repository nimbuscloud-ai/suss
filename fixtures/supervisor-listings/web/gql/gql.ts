// A stand-in for the module graphql-codegen's client preset generates.
export function graphql(source: string): unknown {
  return { source };
}
