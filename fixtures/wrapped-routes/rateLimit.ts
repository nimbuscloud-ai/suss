// A middleware whose 429 no contract on the app declares.

import type { Context, Next } from "hono";

export async function rateLimit(c: Context, next: Next) {
  if (c.req.header("x-burst") !== undefined) {
    return c.json({ error: "slow down" }, 429);
  }

  await next();
}
