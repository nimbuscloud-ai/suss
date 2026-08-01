// Documents as named constants, which is how a codebase of any size
// writes them: the operation lives next to its siblings and the
// component imports the name.

import { gql } from "./generated/gql.js";
import { graphql } from "./generated/gql.js";
import { gql as apolloGql } from "@apollo/client";

export const WIDGET_SETTINGS_QUERY_DOCUMENT = gql(/* GraphQL */ `
  query WidgetSettings($region: String!) {
    widgetSettings(region: $region) {
      id
      label
    }
  }
`);

export const CREATE_WIDGET_MUTATION_DOCUMENT = graphql(`
  mutation CreateWidget($label: String!) {
    createWidget(label: $label) {
      id
    }
  }
`);

export const TICKS_SUBSCRIPTION_DOCUMENT = apolloGql`
  subscription OnTick {
    tick
  }
`;
