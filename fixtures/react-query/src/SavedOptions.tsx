// Options kept in a module constant and handed to the hook by name,
// alone and in the v3 position after the key. The name is the options
// object, not the function the hook runs.

import { useMutation, useQuery } from "react-query";

import { fetchOrders, postOrder } from "./api";

const saveOptions = { mutationFn: postOrder };
const listOptions = { queryFn: fetchOrders, staleTime: 1000 };

export function SavedOptions() {
  const save = useMutation(saveOptions);
  const list = useQuery(["orders", "saved"], listOptions);
  return (
    <section>
      {String(save)}
      {String(list)}
    </section>
  );
}
