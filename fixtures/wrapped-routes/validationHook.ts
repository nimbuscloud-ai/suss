// The hook the app runs when a request fails a route's schema. It
// responds in the handler's place, so no handler shows the 400.

import type { Context } from "hono";

export const validationHook = (
  result: { success: boolean; error?: { issues: unknown[] } },
  c: Context,
) => {
  if (!result.success) {
    return c.json({ error: "invalid request", issues: result.error?.issues }, 400);
  }
};
