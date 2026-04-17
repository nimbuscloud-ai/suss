// Thin axios wrapper. Path-passthrough means the wrapper itself has no
// extractable path; suss's wrapper expansion finds the callers and uses
// each call site's literal/template-literal path.

import axios from "axios";

const api = axios.create({
  baseURL: "https://petstore3.swagger.io/api/v3",
});

export async function getJson<T>(path: string): Promise<T> {
  const { data } = await api.get(path);
  return data;
}
