// Lambda handler that reads DATABASE_URL and OLD_S3_BUCKET. The
// template also declares LEGACY_FEATURE_FLAG, which nothing here
// reads anymore — the dead-config case.

export async function handler(): Promise<{ count: number }> {
  await preflight(process.env.DATABASE_URL, process.env.OLD_S3_BUCKET);
  const count = await reconcile();
  return { count };
}

async function preflight(
  _db: string | undefined,
  _bucket: string | undefined,
): Promise<void> {
  // Stub.
}

async function reconcile(): Promise<number> {
  return 0;
}
