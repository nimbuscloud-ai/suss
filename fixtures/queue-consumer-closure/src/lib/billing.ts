// Imported by the orders handler, so it runs in OrdersWorker.

export async function chargeAccount(account: string): Promise<void> {
  await fetch("https://billing.example.internal/v1/charges", {
    method: "POST",
    body: JSON.stringify({ account }),
  });
}
