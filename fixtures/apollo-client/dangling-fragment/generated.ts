import { gql } from "@apollo/client";

// Codegen output shape: the composed document defines the fragment the
// source document only spreads. The consumer imports the raw source
// document instead, so this constant never reaches a call site.
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
