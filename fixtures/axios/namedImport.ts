// Consumer reaching the shared instance through a named import, one
// hop from the file that builds it.

import { client } from "./api";

export async function getUser(id: string) {
  const res = await client.get(`/users/${id}`);
  return res.data;
}
