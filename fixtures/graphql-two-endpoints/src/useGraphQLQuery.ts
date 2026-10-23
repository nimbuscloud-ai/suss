// Every component calls this hook, and the option it passes picks the
// service the operation goes to.

import { useQuery } from "@apollo/client";

import { appSyncClient, railsClient } from "./clients.js";

interface QueryOptions {
  variables?: Record<string, unknown>;
  nextGen?: boolean;
}

export function useGraphQLQuery(
  doc: unknown,
  { nextGen, ...opts }: QueryOptions = {},
) {
  const client = nextGen ? appSyncClient : railsClient;
  return useQuery(doc as never, { ...opts, client } as never);
}
