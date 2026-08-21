import { type ApolloClient, useApolloClient } from "@apollo/client";

import { checkOrderInvoicesStatus } from "./queries";

export function useInvoiceStatusPolling() {
  const apolloClient: ApolloClient<unknown> = useApolloClient();
  return (orderId: string) =>
    apolloClient.query({
      fetchPolicy: "network-only",
      query: checkOrderInvoicesStatus,
      variables: { id: orderId },
    });
}
