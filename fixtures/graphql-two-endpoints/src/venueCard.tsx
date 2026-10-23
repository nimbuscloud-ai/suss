// Passes the client straight to the hook, without the project's own hook.

import { gql, useQuery } from "@apollo/client";

import { appSyncClient } from "./clients.js";

const VENUE_CARD = gql`
  query VenueCard($id: ID!) {
    venue(id: $id) {
      id
      name
    }
  }
`;

export function VenueCard({ id }: { id: string }) {
  const { data } = useQuery(VENUE_CARD, {
    client: appSyncClient,
    variables: { id },
  });
  return data;
}
