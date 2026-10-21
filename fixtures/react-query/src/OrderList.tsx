// Query functions handed to useQuery by name, written in place, under an
// alias, through a member read, and left out.

import { useQuery, useQuery as useOrders } from "@tanstack/react-query";

import { api, fetchOrders } from "./api";

async function queryFn(): Promise<unknown[]> {
  return [];
}

export function OrderList() {
  const named = useQuery({ queryKey: ["orders"], queryFn: fetchOrders });
  const inPlace = useQuery({
    queryKey: ["orders", "recent"],
    queryFn: async () => {
      const response = await fetch("/api/orders/recent");
      return response.json();
    },
  });
  const aliased = useOrders({ queryKey: ["orders", "short"], queryFn });
  const member = useQuery({ queryKey: ["orders", "api"], queryFn: api.fetchOrders });
  const bare = useQuery({ queryKey: ["bare"] });
  return (
    <ul>
      {String(named)}
      {String(inPlace)}
      {String(aliased)}
      {String(member)}
      {String(bare)}
    </ul>
  );
}
