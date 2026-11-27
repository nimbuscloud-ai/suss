// The order panel's calls. Only `loadSummary` goes to a route that is
// not there: the route it called was renamed to `totals`.

export async function loadSummary(id: string) {
  const res = await fetch(`/api/orders/${id}/summary`);
  return (await res.json()).total;
}

export async function loadTotals(id: string) {
  const res = await fetch(`/api/orders/${id}/totals`);
  return (await res.json()).total;
}

export async function loadRobots() {
  const res = await fetch("/robots.txt");
  return res.text();
}

export async function openOrder(id: string) {
  const res = await fetch(`/orders/${id}`);
  return res.ok;
}

export async function loadLegacyReport() {
  const res = await fetch("/legacy/report");
  return res.ok;
}
