// A class given its path prefix when it is made, which two modules
// then construct with two different prefixes. Each construction is a
// route of its own, and the method is a client of both.

import { client } from "./api";

export class Resource {
  constructor(private base: string) {}

  list() {
    return client.get(this.base);
  }
}

export const resourceUsers = new Resource("/users");
export const resourceOrders = new Resource("/orders");
