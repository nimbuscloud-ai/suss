// Consumer renaming the named export at the import site. The alias is
// the file's own spelling; the binding still leads to the same
// construction.

import { client as http } from "./api";

export async function createUser(body: { name: string }) {
  const res = await http.post("/users", body);
  return res.data;
}
