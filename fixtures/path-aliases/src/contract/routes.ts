// The shared contract: route objects holding their own method and path,
// reached from the server through the project's "@/" alias.

import { createRoute } from "@hono/zod-openapi";

export const tenantRoutes = {
  provision: createRoute({
    operationId: "provisionTenant",
    method: "post",
    path: "/v1/tenants/{tenantId}/provision",
    responses: { 200: { description: "provisioned" } },
  }),
  read: createRoute({
    operationId: "readTenant",
    method: "get",
    path: "/v1/tenants/{tenantId}",
    responses: { 200: { description: "the tenant" } },
  }),
} as const;
