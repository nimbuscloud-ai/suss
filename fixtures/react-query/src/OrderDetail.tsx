// A custom hook that wraps useQuery, a component that calls it, and a
// component that imports the hook through the project's barrel.

import { useQuery } from "@tanstack/react-query";

import { fetchOrder } from "./api";
import { useQuery as useBarrelQuery } from "./queryHooks";

export function useOrder(id: string) {
  return useQuery({
    queryKey: ["order", id],
    queryFn: () => fetchOrder(id),
  });
}

export function OrderDetail({ id }: { id: string }) {
  const order = useOrder(id);
  const again = useBarrelQuery({
    queryKey: ["order", id, "again"],
    queryFn: async () => fetchOrder(id),
  });
  return (
    <article>
      {String(order)}
      {String(again)}
    </article>
  );
}
