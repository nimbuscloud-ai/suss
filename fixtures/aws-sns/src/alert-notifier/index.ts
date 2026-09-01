// Lambda that the AlertEvents topic triggers. Nothing in this fixture
// publishes to that topic, so the subscription receives nothing.

import type { SNSEvent } from "aws-lambda";

export async function handler(event: SNSEvent): Promise<{ ok: boolean }> {
  for (const record of event.Records) {
    await page(record.Sns.Message);
  }
  return { ok: true };
}

async function page(_message: string): Promise<void> {
  // Stub: the integration test is about pairing, not about paging.
}
