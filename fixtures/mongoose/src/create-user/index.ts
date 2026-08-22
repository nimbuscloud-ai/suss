// Writes to the users collection. Exercises the create() payload
// extraction: fields come from the object literal's own keys.

import { User } from "../../models/user.js";

export async function handler(event: {
  name: string;
  email: string;
}): Promise<unknown> {
  return await User.create({ name: event.name, email: event.email });
}
