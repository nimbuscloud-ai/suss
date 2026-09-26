export async function submitOrder(sku: string, quantity: number) {
  const res = await fetch("/orders", {
    method: "POST",
    body: JSON.stringify({ sku, quantity }),
  });
  if (res.status === 201) {
    return res.json();
  }
  if (res.status === 400) {
    throw new Error("the order was rejected");
  }
  throw new Error(`unexpected status ${res.status}`);
}
