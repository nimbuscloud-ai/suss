// Writes to the users collection through an update operator.
// Exercises the $set field extraction and the implicit _id selector.

import { User } from "../../models/user.js";

export async function handler(event: {
  id: string;
  active: boolean;
}): Promise<unknown> {
  return await User.findByIdAndUpdate(event.id, {
    $set: { active: event.active },
  });
}
