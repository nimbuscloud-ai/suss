// Every outbound request goes through here, with the verb the caller
// passes deciding which axios call runs.

import axios from "axios";

export class Refused extends Error {}

export async function send(url: string, method: "get" | "post" = "get") {
  if (!url.startsWith("https://")) {
    throw new Refused(url);
  }
  if (method === "post") {
    return await axios.post(url, {});
  }
  return await axios.get(url);
}
