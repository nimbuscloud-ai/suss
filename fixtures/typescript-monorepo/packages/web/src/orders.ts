// The web package asks the API for one order.

export async function loadOrder(id: string) {
  const res = await fetch(`/orders/${id}`);
  if (res.status === 404) {
    return null;
  }
  if (!res.ok) {
    throw new Error(`order ${id} failed: ${res.status}`);
  }
  return res.json();
}
