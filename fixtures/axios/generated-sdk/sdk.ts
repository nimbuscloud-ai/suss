/**
 * The generated service class. Each method writes the path and lets the
 * caller override the client, which is the spelling a code generator
 * produces for an SDK meant to be usable against a second host.
 */

import { client } from "./client.js";

import type { Opts } from "./client.js";

interface Options extends Partial<Opts> {
  client?: typeof client;
}

export class UsersService {
  static readUsers(options?: Options) {
    return (options?.client ?? client).get({
      url: "/api/v1/users/",
      ...options,
    } as Opts);
  }

  static createUser(options: Options) {
    return (options.client ?? client).post({
      url: "/api/v1/users/",
      ...options,
    } as Opts);
  }

  static deleteUser(options: Options) {
    return (options.client ?? client).delete({
      url: "/api/v1/users/{user_id}",
      ...options,
    } as Opts);
  }
}
