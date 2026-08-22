// Reads from the users collection. Exercises a projection object and
// a findById selector against the same collection create-user writes.

import { User } from "../../models/user.js";

export async function handler(event: { id: string }): Promise<unknown> {
  return await User.findById(event.id, { name: 1, email: 1 });
}
