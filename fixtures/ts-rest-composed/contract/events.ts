import { initContract } from "@ts-rest/core";

const ec = initContract();

export const eventsApi = ec.router({
  recordEvent: {
    method: "POST",
    path: "/events",
    responses: {
      204: ec.type<null>(),
      400: ec.type<{ error: string }>(),
    },
  },
});
