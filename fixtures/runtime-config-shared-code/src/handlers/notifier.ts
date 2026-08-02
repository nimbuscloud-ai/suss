// Runs in NotifierFunction. NOTIFY_TOPIC_ARN is declared on that
// function; RETRY_LIMIT is declared nowhere, so it stays a finding once
// the two functions stop sharing each other's reads.

import { logLevel } from "../config/logging.js";

export async function handler(event: { id: string }): Promise<{
  statusCode: number;
}> {
  logLevel();
  await publish(
    process.env.NOTIFY_TOPIC_ARN,
    event.id,
    process.env.RETRY_LIMIT,
  );
  return { statusCode: 200 };
}

async function publish(
  _topic: string | undefined,
  _id: string,
  _retryLimit: string | undefined,
): Promise<void> {
  // Stub.
}
