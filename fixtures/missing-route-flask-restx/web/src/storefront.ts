export async function loadSummary(id: string) {
  const res = await fetch(`${process.env.SHOP_API_URL}/api/orders/${id}/summary`);
  return (await res.json()).total;
}

export async function loadTotals(id: string) {
  const res = await fetch(`${process.env.SHOP_API_URL}/api/orders/${id}/totals`);
  return (await res.json()).total;
}

export async function loadLogo() {
  const res = await fetch(`${process.env.SHOP_API_URL}/static/logo.png`);
  return res.blob();
}

export async function loadInvoice(id: string) {
  const res = await fetch(`${process.env.SHOP_API_URL}/downloads/${id}/invoice.pdf`);
  return res.blob();
}

export async function loadSpec() {
  const res = await fetch(`${process.env.SHOP_API_URL}/api/swagger.json`);
  return res.json();
}

export async function charge(amount: number) {
  const res = await fetch(`${process.env.PAYMENTS_API_URL}/v1/charges`, {
    method: "POST",
    body: JSON.stringify({ amount }),
  });
  return res.json();
}

export async function loadExport(id: string) {
  const res = await fetch(`${process.env.SHOP_API_URL}/api/files/exports/${id}/report.csv`);
  return res.json();
}
