// Goes to the older server, which has no nickname on Account. That
// selection is a bug the check should still report.

import { gql } from "@apollo/client";

import { useGraphQLQuery } from "./useGraphQLQuery.js";

const ACCOUNT_PAGE = gql`
  query AccountPage {
    account {
      id
      email
      nickname
    }
  }
`;

export function AccountPage() {
  const { data } = useGraphQLQuery(ACCOUNT_PAGE);
  return data;
}
