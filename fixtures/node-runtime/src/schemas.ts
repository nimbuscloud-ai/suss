// Environment schemas from the five validation libraries the node pack
// reads. Each schema's keys are the variables read.

import { createEnv } from "@t3-oss/env-core";
import { cleanEnv, port, str } from "envalid";
import * as v from "valibot";
import { z } from "zod";
import { parseEnv } from "znv";

const shared = { LOG_FORMAT: z.string().default("json") };

const Env = z.object({
  ...shared,
  PORT: z.coerce.number().int().positive().default(8080),
  ACCOUNTS_TABLE: z.string().optional(),
  ORDERS_URL: z.string(),
  RETRY_LIMIT: z.string().nullish(),
  FALLBACK_URL: z.string().catch("http://localhost"),
  MODE: z.string().or(z.literal("none")),
});

export function loadConfig(env = process.env) {
  return Env.parse(env);
}

export function startup() {
  return loadConfig();
}

export function strictConfig() {
  return z.object({ AUDIT_URL: z.string() }).strict().safeParse(process.env);
}

export function envalidConfig() {
  return cleanEnv(process.env, {
    METRICS_PORT: port({ default: 9100 }),
    METRICS_TOKEN: str(),
    METRICS_QUEUE: str({ devDefault: "local" }),
  });
}

export function t3Config() {
  return createEnv({
    server: { BILLING_TABLE: z.string() },
    shared: { BILLING_REGION: z.string().optional() },
    runtimeEnv: process.env,
  });
}

export function znvConfig() {
  return parseEnv(process.env, {
    WORKER_COUNT: z.number().default(4),
    WORKER_QUEUE: z.string(),
  });
}

export function valibotConfig() {
  return v.parse(
    v.object({ EXPORT_BUCKET: v.string(), EXPORT_PREFIX: v.optional(v.string()) }),
    process.env,
  );
}

// A request body parsed in a file that also reads the environment.
export function parseRequest(body: unknown) {
  return z.object({ id: z.string() }).parse(body);
}
