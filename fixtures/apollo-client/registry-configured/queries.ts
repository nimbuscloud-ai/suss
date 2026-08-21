import { gql } from "@apollo/client";

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
