// Consumer fixture for fragment composition: a `gql` fragment constant
// interpolated into the operation's template (#461), the usual way
// Apollo codebases write fragments.

import { gql, useQuery } from "@apollo/client";

const OWNER_FIELDS = gql`
  fragment OwnerFields on Owner {
    id
    displayName
  }
`;

const GET_OWNER = gql`
  query GetOwner($id: ID!) {
    owner(id: $id) {
      ...OwnerFields
    }
  }
  ${OWNER_FIELDS}
`;

export function useOwner(id: string) {
  const { data } = useQuery(GET_OWNER, { variables: { id } });
  return data?.owner;
}
