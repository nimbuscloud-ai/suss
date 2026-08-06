// The client call the fixture traces end to end:
// GET https://shop.example.com/api/orders/123.

export async function fetchOrder() {
  const res = await fetch("https://shop.example.com/api/orders/123");
  const order = await res.json();
  return order;
}
