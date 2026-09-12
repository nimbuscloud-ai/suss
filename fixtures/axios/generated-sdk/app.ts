/**
 * The application code, which sees only the service class. Two more
 * hops separate these functions from the axios call.
 */

import { UsersService } from "./sdk.js";

export async function listUsers() {
  return UsersService.readUsers();
}

export async function removeUser(userId: number) {
  return UsersService.deleteUser({ path: { user_id: userId } });
}
