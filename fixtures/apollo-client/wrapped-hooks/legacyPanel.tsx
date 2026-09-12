// Two wrappers away from Apollo, and imported through the barrel, so
// the operation is found only by following both hops.

import { gql } from "@apollo/client";

import { useLegacyQuery } from "./index.js";

const LEGACY_ORDERS_QUERY = gql`
  query LegacyOrders {
    orders {
      id
    }
  }
`;

export function LegacyPanel() {
  const { data } = useLegacyQuery(LEGACY_ORDERS_QUERY);
  return data;
}
