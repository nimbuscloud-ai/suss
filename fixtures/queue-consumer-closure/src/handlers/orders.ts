// Runs in OrdersWorker, which drains OrdersQueue. Both calls it makes
// happen again when the queue delivers a message twice: the one here
// and the one inside the billing helper it imports.

import { chargeAccount } from "../lib/billing";

export async function handler(event: {
  Records: Array<{ body: string }>;
}): Promise<void> {
  for (const record of event.Records) {
    const order = JSON.parse(record.body) as { id: string; account: string };
    await fetch("https://orders.example.internal/v1/receipts", {
      method: "POST",
      body: JSON.stringify({ orderId: order.id }),
    });
    await chargeAccount(order.account);
  }
}
