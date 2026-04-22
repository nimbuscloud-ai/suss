import { initContract } from "@ts-rest/core";

import { eventsApi } from "./events";
import { internalApi } from "./internal";

const c = initContract();

export const apiContract = c.router(
  {
    events: eventsApi,
    internal: internalApi,
  },
  { pathPrefix: "/api/v1" },
);
