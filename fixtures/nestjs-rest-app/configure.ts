// The prefix and the routes it leaves out come from constants, the way
// a project shares them with its client.
import { type INestApplication, RequestMethod } from "@nestjs/common";

import { API_PREFIX, UNPREFIXED } from "./paths";

export function configureApp(app: INestApplication) {
  app.setGlobalPrefix(API_PREFIX, {
    exclude: [
      ...UNPREFIXED,
      { path: "orders/export", method: RequestMethod.GET },
    ],
  });
}
