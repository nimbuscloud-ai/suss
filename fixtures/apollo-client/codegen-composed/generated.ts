import { gql } from "@apollo/client";

export const CheckOrderInvoicesStatusDocument = gql`
  query CheckOrderInvoicesStatus($id: ID!) {
    order(id: $id) {
      id
      invoices {
        ...Invoice
      }
    }
  }
  fragment Invoice on Invoice {
    id
    number
    createdAt
    url
    status
  }
`;
