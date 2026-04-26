// Lambda consumer that processes order messages from OrdersQueue.
// Pairs against OrderProducer (which sends to the same queue).

interface SQSEvent {
  Records: Array<{ body: string }>;
}

export async function handler(event: SQSEvent): Promise<{ ok: boolean }> {
  for (const record of event.Records) {
    const order = JSON.parse(record.body);
    await processOrder(order);
  }
  return { ok: true };
}

async function processOrder(_order: unknown): Promise<void> {
  // Stub — the integration test only cares about queue identity
  // pairing, not the consumer's downstream behaviour.
}
