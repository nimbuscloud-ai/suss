export async function loadSummary(id: string) {
  const res = await fetch(`${process.env.SHOP_API_URL}/orders/${id}/summary`);
  return (await res.json()).total;
}

export async function loadTotals(id: string) {
  const res = await fetch(`${process.env.SHOP_API_URL}/orders/${id}/totals`);
  return (await res.json()).total;
}

export async function loadFeed(id: string) {
  const res = await fetch(`${process.env.SHOP_API_URL}/orders/${id}/feed`);
  return res.json();
}

export async function loadQueue() {
  const res = await fetch(`${process.env.SHOP_API_URL}/jobs/queues`);
  return res.ok;
}
