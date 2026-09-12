// Operations kept next to their siblings, which is how a codebase of
// any size writes them. The component imports the name.

import { gql } from "@apollo/client";

export const SETTINGS_QUERY = gql`
  query Settings($region: String!) {
    settings(region: $region) {
      id
      label
    }
  }
`;
