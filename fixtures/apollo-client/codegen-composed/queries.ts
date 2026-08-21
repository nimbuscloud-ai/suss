import { gql } from "@apollo/client";

// The raw source document with the dangling spread. Nothing imports
// it; the consumer uses the composed document in generated.ts.
export const checkOrderInvoicesStatus = gql`
  query CheckOrderInvoicesStatus($id: ID!) {
    order(id: $id) {
      id
      invoices {
        ...Invoice
      }
    }
  }
`;
