// The document is decided at run time, so this call is reported
// without an operation and the gap says which argument to go look at.
// The wrapper is still expanded for every other caller.

import { gql } from "@apollo/client";

import { useAppQuery } from "./index.js";

const WEEKLY_QUERY = gql`
  query Weekly {
    weekly {
      id
    }
  }
`;

const DAILY_QUERY = gql`
  query Daily {
    daily {
      id
    }
  }
`;

declare const preferWeekly: boolean;

export function Dashboard() {
  const { data } = useAppQuery(preferWeekly ? WEEKLY_QUERY : DAILY_QUERY);
  return data;
}
