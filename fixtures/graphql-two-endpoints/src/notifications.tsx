// Passes no client, so Apollo uses the one the app provides. With two
// clients built and no provider read, that operation keeps pairing the
// way it did before.

import { gql, useQuery } from "@apollo/client";

const NOTIFICATIONS = gql`
  query Notifications {
    events {
      id
    }
  }
`;

export function Notifications() {
  const { data } = useQuery(NOTIFICATIONS);
  return data;
}
