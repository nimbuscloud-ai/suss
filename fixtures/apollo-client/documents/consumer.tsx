// Consumer fixture for documents held in named constants:
//   - imported through a barrel, built by a `gql(...)` tag call
//   - imported through a barrel, built by `graphql(...)`
//   - imported through a barrel, built by a `gql` tagged template
//   - declared in this module, one hop of aliasing away
//   - `useLazyQuery`, which is what a query bound to an event uses
//   - two hooks in one component, which are two boundaries
//   - a document the code computes, which is reported as a gap

import {
  useLazyQuery,
  useMutation,
  useQuery,
  useSubscription,
} from "@apollo/client";

import {
  CREATE_WIDGET_MUTATION_DOCUMENT,
  WIDGET_SETTINGS_QUERY_DOCUMENT,
  TICKS_SUBSCRIPTION_DOCUMENT,
} from "./barrel.js";
import { gql } from "./generated/gql.js";

export function useWidgetSettings(region: string) {
  return useQuery(WIDGET_SETTINGS_QUERY_DOCUMENT, { variables: { region } });
}

export function useCreateWidget() {
  return useMutation(CREATE_WIDGET_MUTATION_DOCUMENT);
}

export function useWidgetTicks() {
  return useSubscription(TICKS_SUBSCRIPTION_DOCUMENT);
}

const SEARCH_USERS_QUERY_DOCUMENT = gql(/* GraphQL */ `
  query SearchUsers($term: String!) {
    searchUsers(term: $term) {
      id
      name
    }
  }
`);

const USER_QUERY_DOCUMENT = gql(/* GraphQL */ `
  query User($id: ID!) {
    user(id: $id) {
      id
    }
  }
`);

const SEARCH_USERS_ALIAS = SEARCH_USERS_QUERY_DOCUMENT;

// Two documents, one component body. Both are boundaries.
export function UserPicker() {
  const [search] = useLazyQuery(SEARCH_USERS_ALIAS);
  const [load] = useLazyQuery(USER_QUERY_DOCUMENT);
  return { search, load };
}

declare const preferLegacy: boolean;
const CHOSEN_DOCUMENT = preferLegacy
  ? SEARCH_USERS_QUERY_DOCUMENT
  : USER_QUERY_DOCUMENT;

// The document is decided at runtime, so the call is reported without
// an operation and the gap says which argument to go look at.
export function useChosen() {
  return useQuery(CHOSEN_DOCUMENT);
}
