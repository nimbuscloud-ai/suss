// Lambda invoked on a SAM Events Type: Schedule (rate(1 day)). A
// schedule is time-triggered, so there's no message producer to pair
// against. The pairing check accounts for the target without flagging
// it as a consumer-orphan.

export async function handler(): Promise<{ ok: boolean }> {
  return { ok: true };
}
