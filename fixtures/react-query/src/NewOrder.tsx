// Mutations: the function passed by name, written in place, and under
// `mutationFn`.

import { useMutation, useQueryClient } from "@tanstack/react-query";

import { postOrder } from "./api";

export function NewOrder() {
  const client = useQueryClient();
  const create = useMutation({
    mutationFn: postOrder,
    onSuccess: () => client.invalidateQueries({ queryKey: ["orders"] }),
  });
  const cancel = useMutation({
    mutationFn: async (id: string) => {
      await fetch(`/api/orders/${id}`, { method: "DELETE" });
    },
  });
  return (
    <form>
      <button type="submit">{String(create)}</button>
      <button type="button">{String(cancel)}</button>
    </form>
  );
}
