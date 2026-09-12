// The one hook every component in this app calls. It picks the client
// and hands the document straight through, so the document argument
// inside it is a parameter, which is no operation at all.

import { useMutation, useQuery } from "@apollo/client";

declare function useAppClient(options?: { legacy?: boolean }): unknown;

export const useAppQuery = (
  query: unknown,
  options?: { variables?: Record<string, unknown> },
  clientOptions?: { legacy?: boolean },
) => {
  const client = useAppClient(clientOptions);
  return useQuery(query as never, { ...options, client } as never);
};

export function useAppMutation(mutation: unknown) {
  const client = useAppClient();
  return useMutation(mutation as never, { client } as never);
}
