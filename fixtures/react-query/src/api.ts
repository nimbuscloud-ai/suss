// The calls the query functions make.

export interface Order {
  id: string;
  total: number;
}

export async function fetchOrders(): Promise<Order[]> {
  const response = await fetch("/api/orders");
  return (await response.json()) as Order[];
}

export async function fetchOrder(id: string): Promise<Order> {
  const response = await fetch(`/api/orders/${id}`);
  return (await response.json()) as Order;
}

export async function postOrder(order: Omit<Order, "id">): Promise<Order> {
  const response = await fetch("/api/orders", {
    method: "POST",
    body: JSON.stringify(order),
  });
  return (await response.json()) as Order;
}

export const api = {
  fetchOrders,
  async fetchPage(cursor: number): Promise<Order[]> {
    const response = await fetch(`/api/orders?cursor=${cursor}`);
    return (await response.json()) as Order[];
  },
};
