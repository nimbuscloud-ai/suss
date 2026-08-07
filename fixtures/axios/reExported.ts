// Consumer importing the instance through the barrel rather than from
// the file that builds it. The extra hop changes nothing: the binding
// still leads to the one construction, and the call site summarizes
// the same as a direct import.

import { client } from "./barrel";

export async function getReport() {
  const res = await client.get("/reports/weekly");
  return res.data;
}
