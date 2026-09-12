// A hook this package exports for other repositories. Nothing in this
// run calls it, so the wrapper keeps its own summary and the gap says
// no caller was found.

import { useSubscription } from "@apollo/client";

export function usePublicSubscription(document: unknown) {
  return useSubscription(document as never);
}
