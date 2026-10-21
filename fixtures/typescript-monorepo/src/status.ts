// The root package's own code: a status check against the API.

import axios from "axios";

export async function apiIsUp(): Promise<boolean> {
  const res = await axios.get("/status");
  if (res.status === 503) {
    return false;
  }
  return res.status === 200;
}
