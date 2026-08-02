// Runs in IngestFunction. LOG_LEVEL comes from the Globals section,
// TABLE_NAME from the function's own environment, and RETRY_LIMIT from
// nowhere, so only the last one is a finding.

export async function handler(event: { id: string }): Promise<{
  statusCode: number;
}> {
  await store(
    process.env.TABLE_NAME,
    event.id,
    process.env.LOG_LEVEL,
    process.env.RETRY_LIMIT,
  );
  return { statusCode: 200 };
}

async function store(
  _table: string | undefined,
  _id: string,
  _logLevel: string | undefined,
  _retryLimit: string | undefined,
): Promise<void> {
  // Stub. The pairing pass only cares about the reads above.
}
