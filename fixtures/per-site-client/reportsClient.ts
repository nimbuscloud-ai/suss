// A client given an API key when it is made, built inside an async
// factory out of a value the config call came back with.

import { http } from "./http";
import { loadConfig } from "./config";

export class ReportsClient {
  constructor(private readonly apiKey: string) {}

  fetchDaily() {
    return http.get("/reports/daily", {
      headers: { "X-Api-Key": this.apiKey },
    });
  }
}

export async function reportsClient() {
  const config = await loadConfig();
  return new ReportsClient(config.apiKey);
}
