// Lambda handler that reads STRIPE_WEBHOOK_SECRET (declared) and
// KAFKA_BROKER (NOT declared in the template — the omission case).

export async function handler(event: { signature: string }): Promise<{
  ok: boolean;
}> {
  await verifyAndForward(
    process.env.STRIPE_WEBHOOK_SECRET,
    event.signature,
    process.env.KAFKA_BROKER,
  );
  return { ok: true };
}

async function verifyAndForward(
  _secret: string | undefined,
  _signature: string,
  _broker: string | undefined,
): Promise<void> {
  // Stub.
}
