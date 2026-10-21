// Route wrappers a logging library builds. The factory's body is in a
// package this project does not ship, so no run can read what the
// wrappers it returns do around a route.

import { createAxiomRouteHandler } from "@axiomhq/nextjs";

declare const logger: { flush(): Promise<void> };

export const withAxiom = createAxiomRouteHandler(logger);

export const withAxiomBodyLog = createAxiomRouteHandler(logger, {
  onSuccess: async () => {
    await logger.flush();
  },
});
