// Consumer fixture exercising several Apollo Client shapes:
//   - Named query via const + `gql`
//   - Named mutation directly inline in `useMutation(gql`mutation ...`)`
//   - Anonymous query (`gql`query { ... }`` with no name)
//   - Subscription
//   - Hook imported under an alias
//
// No JSX here on purpose — the pack targets the hook calls, not the
// surrounding render tree.

import { gql, useMutation as useApolloMutation, useQuery, useSubscription } from "@apollo/client";

const GET_PET = gql`
  query GetPet($id: ID!) {
    pet(id: $id) {
      id
      name
    }
  }
`;

export function usePet(id: string) {
  const { data, error } = useQuery(GET_PET, { variables: { id } });
  if (error) {
    throw error;
  }
  return data?.pet;
}

export function useCreatePet() {
  return useApolloMutation(gql`
    mutation CreatePet($name: String!) {
      createPet(name: $name) { id }
    }
  `);
}

export function useAnonPing() {
  return useQuery(gql`
    query {
      ping
    }
  `);
}

export function useTicks() {
  return useSubscription(gql`
    subscription OnTick {
      tick
    }
  `);
}

// Imperative client path — common in getServerSideProps, Node
// scripts, or anywhere data fetching happens outside a component.
import { ApolloClient, InMemoryCache } from "@apollo/client";

const client = new ApolloClient({
  uri: "https://api.example.com/graphql",
  cache: new InMemoryCache(),
});

export async function loadPetById(id: string) {
  const result = await client.query({
    query: gql`
      query LoadPet($id: ID!) {
        pet(id: $id) {
          id
          name
        }
      }
    `,
    variables: { id },
  });
  return result.data?.pet;
}

export async function createPetImperative(name: string) {
  const result = await client.mutate({
    mutation: gql`
      mutation CreatePetImperative($name: String!) {
        createPet(name: $name) { id }
      }
    `,
    variables: { name },
  });
  return result.data?.createPet;
}

// .graphql file import — the document lives in a separate file so
// build tools (graphql-code-generator, webpack loaders, etc.) can
// generate types. The adapter resolves the import relative to
// this source file and reads the SDL.
// @ts-expect-error — no .graphql loader configured in this fixture
import GET_USER_FILE from "./queries/GetUserFile.graphql";

export function useUserFromFile(id: string) {
  return useQuery(GET_USER_FILE, { variables: { id } });
}
