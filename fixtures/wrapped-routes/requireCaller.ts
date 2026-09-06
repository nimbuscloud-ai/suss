// The middleware the app registers, written in its own file, which is
// where most services put one. It is built by a factory that takes the
// header to check, so the app registers a call rather than a name.

import type { Context, Next } from "hono";

export function requireCaller(config: { header: string }) {
  return async (c: Context, next: Next) => {
    if (c.req.header(config.header) === undefined) {
      return c.json({ error: "unauthorized" }, 401);
    }

    await next();
  };
}
