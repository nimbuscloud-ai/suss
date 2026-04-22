import { initContract } from "@ts-rest/core";

const ic = initContract();

export const internalApi = ic.router({
  fetchThing: {
    method: "GET",
    path: "/things/:id",
    responses: {
      200: ic.type<{ id: string; label: string }>(),
      404: ic.type<{ error: string }>(),
    },
  },
});
