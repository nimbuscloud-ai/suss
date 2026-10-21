// Callers of the helpers in another file. Each passes the variable it
// wants in a different way: a literal, a constant, a template, a value
// reassigned before the call.

import {
  makeReader,
  optionalEnv,
  readEnv,
  requireEnv,
  Settings,
  setting,
} from "./requireEnv.js";

const SMTP_HOST = "SMTP_HOST";
const PREFIX = "REPORT_";

export function mailer(): { host: string; port: string } {
  return {
    host: requireEnv(SMTP_HOST),
    port: optionalEnv("SMTP_PORT") ?? "587",
  };
}

export function reportTarget(): string {
  return requireEnv(`${PREFIX}TARGET`);
}

export function apiKey(): string {
  return setting("API_KEY");
}

export function signingKey(): string | undefined {
  return readEnv("SIGNING_KEY");
}

export function cacheTtl(): string {
  const read = makeReader("CACHE_");
  return read("TTL");
}

export function timezone(settings: Settings): string {
  return settings.get("TZ") ?? "UTC";
}

let current = "SHARD_A";
current = "SHARD_B";

export function shard(): string {
  return requireEnv(current);
}
