// Environment reads written directly against process.env, in each
// spelling the node pack reads.

export function databaseUrl(): string {
  return process.env.DATABASE_URL ?? "postgres://localhost/reports";
}

export function logLevel(): string {
  return process.env.LOG_LEVEL || process.env.DEFAULT_LOG_LEVEL || "info";
}

export function region(): string | undefined {
  return process.env["AWS_REGION"];
}

export function bucket(): string {
  return process.env[`REPORT_BUCKET`] ?? "reports-local";
}

export function queueSettings(): { queue: string; batch: string } {
  const { REPORT_QUEUE, BATCH_SIZE: batch = "10", ...others } = process.env;
  void others;
  return { queue: REPORT_QUEUE ?? "reports", batch };
}

export function featureFlag(): boolean {
  const flag = process.env.FEATURE_EXPORT;
  if (flag === undefined) {
    return false;
  }
  return flag === "on";
}

export function tracing(): string {
  return process.env.TRACE_SAMPLE_RATE.toString();
}

// A dotted read off an environment handed in as a parameter.
export function portFrom(env: NodeJS.ProcessEnv = process.env): string {
  return env.PORT ?? "3000";
}
