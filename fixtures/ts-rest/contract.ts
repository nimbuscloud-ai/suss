// fixtures/ts-rest/contract.ts — A ts-rest contract with three endpoints
// Uses realistic patterns but doesn't need @ts-rest/core at runtime.

import { initContract } from "@ts-rest/core";

const c = initContract();

export const contract = c.router({
  getUser: {
    method: "GET",
    path: "/users/:id",
    responses: {
      200: c.type<{ id: string; name: string; email: string }>(),
      404: c.type<{ error: string }>(),
      // 500 is declared but never produced by the handler → gap
      500: c.type<{ error: string }>(),
    },
  },
  createUser: {
    method: "POST",
    path: "/users",
    responses: {
      201: c.type<{ id: string }>(),
      400: c.type<{ error: string }>(),
    },
  },
});
