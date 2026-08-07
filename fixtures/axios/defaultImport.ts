// Consumer reaching the default-exported instance, under whatever
// local name the importing file picks.

import api from "./apiDefault";

export async function listOrders() {
  const res = await api.get("/orders");
  return res.data;
}
