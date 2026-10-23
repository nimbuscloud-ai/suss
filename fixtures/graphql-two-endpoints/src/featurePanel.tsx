// A feature flag picks the service at run time, so neither schema can
// be said to be the one this operation reaches.

import { gql } from "@apollo/client";

import { useFeatureFlag } from "./featureFlags.js";
import { useGraphQLQuery } from "./useGraphQLQuery.js";

const FEATURE_PANEL = gql`
  query FeaturePanel {
    events {
      id
      venue {
        name
      }
    }
  }
`;

export function FeaturePanel() {
  const { data } = useGraphQLQuery(FEATURE_PANEL, {
    nextGen: useFeatureFlag("new-event-listings"),
  });
  return data;
}
