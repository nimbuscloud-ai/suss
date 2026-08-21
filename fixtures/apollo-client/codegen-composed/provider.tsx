import { type ApolloClient, useApolloClient } from "@apollo/client";

import { CheckOrderInvoicesStatusDocument } from "./generated";

export function useInvoiceStatusPolling() {
  const apolloClient: ApolloClient<unknown> = useApolloClient();
  return (orderId: string) =>
    apolloClient.query({
      fetchPolicy: "network-only",
      query: CheckOrderInvoicesStatusDocument,
      variables: { id: orderId },
    });
}
