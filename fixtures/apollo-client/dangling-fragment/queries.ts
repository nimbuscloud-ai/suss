import { gql } from "@apollo/client";

// The source document spreads a fragment it does not define and does
// not interpolate. The composed version lives in generated.ts, and
// nothing imports it.
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
