// Consumer of the runtime-configured client. The call site is still a
// boundary worth recording, and its summary carries the path written
// here; the unknowable base stays a gap rather than a guess.

import { dynamicClient } from "./apiDynamic";

export async function getSettings() {
  const res = await dynamicClient.get("/settings");
  return res.data;
}
