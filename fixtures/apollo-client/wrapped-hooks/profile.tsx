// A component with the document written beside it, calling the
// project's hook rather than Apollo's.

import { gql } from "@apollo/client";

import { useAppQuery } from "./hooks.js";

const PROFILE_QUERY = gql`
  query Profile($id: ID!) {
    user(id: $id) {
      id
      name
    }
  }
`;

export function Profile({ id }: { id: string }) {
  const { data, error } = useAppQuery(PROFILE_QUERY, { variables: { id } });
  if (error !== undefined) {
    return "profile unavailable";
  }
  return data;
}
