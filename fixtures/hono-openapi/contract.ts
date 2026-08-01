// The contract half of a zod-openapi service: route objects built by
// createRoute, holding their own method and path, shared from one file
// so the OpenAPI document and the server register the same thing.

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
