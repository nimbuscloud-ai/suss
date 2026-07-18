// Consumer component in a graphql-codegen client-preset layout: the
// documents are imported from a generated module (and one hand-authored
// operations module), never written inline. This is the dominant
// production shape the pack has to resolve across module boundaries.
//
// No JSX here — the pack targets the hook calls, not the render tree.

import { useMutation, useQuery } from "@apollo/client";

import { AdoptPetDocument, GetPetsDocument } from "./generated/graphql";
import { LIST_TAGS } from "./operations";

export function usePetList(first: number) {
  const { data, error } = useQuery(GetPetsDocument, { variables: { first } });
  if (error) {
    throw error;
  }
  return data?.pets;
}

export function useAdoptPet() {
  return useMutation(AdoptPetDocument);
}

export function useTags() {
  return useQuery(LIST_TAGS);
}
