// The server half: handlers registered on an app the function was
// handed, against routes that live on the shared contract.

import { OpenAPIHono } from "@hono/zod-openapi";

import { tenantRoutes } from "./contract";

declare const store: {
  provision(id: string): Promise<{ status: string } | null>;
};

export function registerTenantHandlers(app: OpenAPIHono): void {
  app.openapi(tenantRoutes.provision, async (c) => {
    const result = await store.provision("t1");
    if (result === null) {
      return c.json({ error: "conflict" }, 409);
    }
    return c.json(result, 200);
  });

  app.openapi(tenantRoutes.read, async (c) => {
    return c.json({ status: "ready" }, 200);
  });
}
