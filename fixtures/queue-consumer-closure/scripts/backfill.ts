// A one-off script run by hand. It is inside the functions' CodeUri,
// and no handler imports it.

export async function backfillRefunds(ids: string[]): Promise<void> {
  for (const id of ids) {
    await fetch("https://billing.example.internal/v1/refunds", {
      method: "POST",
      body: JSON.stringify({ id }),
    });
  }
}
