// Lambda handler that reads DATABASE_URL and OLD_S3_BUCKET. The
// template also declares LEGACY_FEATURE_FLAG, which nothing here
// reads anymore — the dead-config case.

let resolvedVersion: string | undefined;

export async function handler(): Promise<{ count: number }> {
  await preflight(process.env.DATABASE_URL, process.env.OLD_S3_BUCKET);
  initVersion();
  const count = await reconcile(reportPrefix());
  return { count };
}

// APP_VERSION is an optional override the template does not declare,
// used only behind a presence test.
function initVersion(): void {
  const envVersion = process.env.APP_VERSION;
  if (envVersion) {
    resolvedVersion = envVersion;
    return;
  }
  resolvedVersion = "unknown";
}

// REPORT_PREFIX is undeclared too, and used past its test as well.
function reportPrefix(): string {
  const prefix = process.env.REPORT_PREFIX;
  if (prefix) {
    return `${prefix}/${resolvedVersion}`;
  }
  return String(prefix);
}

async function preflight(
  _db: string | undefined,
  _bucket: string | undefined,
): Promise<void> {
  // Stub.
}

async function reconcile(_prefix: string): Promise<number> {
  return 0;
}
