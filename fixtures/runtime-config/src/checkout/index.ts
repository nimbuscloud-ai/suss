// Lambda handler that reads STRIPE_API_KEY (which the template
// misnames as STRIPE_KEY) and DATABASE_URL.
//
// Reads are inline at the call site so the pairing layer's
// post-hoc EffectArg-identifier scan finds the process.env
// references. Let-binding the values first hides the initializer
// behind a local name — a known limitation the extractor's Gap 5b
// dataflow improvement will close in a follow-up.

export async function handler(event: { amount: number }): Promise<{
  ok: boolean;
}> {
  await chargeCard(
    process.env.STRIPE_API_KEY,
    event.amount,
    process.env.DATABASE_URL,
  );
  return { ok: true };
}

async function chargeCard(
  _key: string | undefined,
  _amount: number,
  _db: string | undefined,
): Promise<void> {
  // Stub — the integration test only cares about env-var reads.
}
