export function cancelOrder(id: string) {
  return { id, status: "cancelled" };
}
