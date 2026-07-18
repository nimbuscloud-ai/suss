// Mirrors the module GraphQL Code Generator's client-preset emits: each
// operation is a plain object literal (the graphql-js DocumentNode AST)
// cast through `unknown` to a typed `TypedDocumentNode<Result, Vars>`.
// Components import these constants and pass them straight to the hooks.
//
// Neutral domain (a pet store) — no real project referenced.

export type TypedDocumentNode<Result, Variables> = {
  __apiType?: (variables: Variables) => Result;
};

export type GetPetsQuery = { pets: Array<{ id: string; name: string }> };
export type GetPetsQueryVariables = { first?: number };

export const GetPetsDocument = {
  kind: "Document",
  definitions: [
    {
      kind: "OperationDefinition",
      operation: "query",
      name: { kind: "Name", value: "GetPets" },
      variableDefinitions: [
        {
          kind: "VariableDefinition",
          variable: { kind: "Variable", name: { kind: "Name", value: "first" } },
          type: { kind: "NamedType", name: { kind: "Name", value: "Int" } },
        },
      ],
      selectionSet: {
        kind: "SelectionSet",
        selections: [
          {
            kind: "Field",
            name: { kind: "Name", value: "pets" },
            selectionSet: {
              kind: "SelectionSet",
              selections: [
                { kind: "Field", name: { kind: "Name", value: "id" } },
                { kind: "Field", name: { kind: "Name", value: "name" } },
              ],
            },
          },
        ],
      },
    },
  ],
} as unknown as TypedDocumentNode<GetPetsQuery, GetPetsQueryVariables>;

export type AdoptPetMutation = { adoptPet: { id: string } };
export type AdoptPetMutationVariables = { id: string };

// A codegen setup where the document body isn't inlined as a readable
// object literal — here it comes from a helper call, so static
// evaluation can't reach the AST. The operation header falls back to
// the `TypedDocumentNode` type arguments (`AdoptPetMutation` →
// mutation / AdoptPet), and the unreadable body surfaces on the summary
// as `metadata.graphql.unresolvedDocument`.
declare function buildDocument(source: string): unknown;

export const AdoptPetDocument = buildDocument(
  "mutation AdoptPet($id: ID!) { adoptPet(id: $id) { id } }",
) as unknown as TypedDocumentNode<AdoptPetMutation, AdoptPetMutationVariables>;
