// Hand-authored operations kept in a shared module and imported by
// components — the pre-codegen convention that still coexists with
// generated documents. The `gql` tag lives here, not at the call site.

import { gql } from "@apollo/client";

export const LIST_TAGS = gql`
  query ListTags {
    tags {
      id
      name
    }
  }
`;
