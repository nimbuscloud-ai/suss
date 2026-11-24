export async function loadSummary(id: string) {
  const res = await fetch(`/api/orders/${id}/summary`);
  return (await res.json()).total;
}

export async function loadTotals(id: string) {
  const res = await fetch(`/api/orders/${id}/totals`);
  return (await res.json()).total;
}

export async function loadLogo() {
  const res = await fetch("/assets/logo.png");
  return res.ok;
}
