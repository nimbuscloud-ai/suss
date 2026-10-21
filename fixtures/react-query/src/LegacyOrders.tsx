// The v3 package, which takes the key and the function as positional
// arguments.

import { useMutation, useQuery } from "react-query";

import { fetchOrder, postOrder } from "./api";

export function LegacyOrders({ id }: { id: string }) {
  const list = useQuery(["orders"], async () => {
    const response = await fetch("/api/orders");
    return response.json();
  });
  const one = useQuery(["orders", id], () => fetchOrder(id), {
    staleTime: 1000,
  });
  const withOptions = useQuery(["orders", "options"], undefined, {
    queryFn: () => fetchOrder(id),
  });
  const save = useMutation(postOrder);
  return (
    <section>
      {String(list)}
      {String(one)}
      {String(withOptions)}
      {String(save)}
    </section>
  );
}
