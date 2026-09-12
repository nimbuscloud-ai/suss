// A wrapper over the wrapper, for the pages still on the old client.
// Two hops from the library, so the component at the top is where the
// operation is written.

import { useAppQuery } from "./hooks.js";

export function useLegacyQuery(query: unknown) {
  return useAppQuery(query, undefined, { legacy: true });
}
