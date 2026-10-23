// Goes to the newer API, whose Event has a venue.

import { gql } from "@apollo/client";

import { useGraphQLQuery } from "./useGraphQLQuery.js";

const EVENT_LISTING = gql`
  query EventListing {
    events {
      id
      title
      venue {
        name
      }
    }
  }
`;

export function EventListing() {
  const { data } = useGraphQLQuery(EVENT_LISTING, {
    variables: {},
    nextGen: true,
  });
  return data;
}
