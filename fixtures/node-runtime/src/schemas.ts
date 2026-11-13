// Environment schemas from the five validation libraries the node pack
// reads. Each schema's keys are the variables read.

import { createEnv } from "@t3-oss/env-core";
import { cleanEnv, cleanEnv as load, port, str } from "envalid";
import * as v from "valibot";
import { z } from "zod";
import { parseEnv } from "znv";

import { AppEnv } from "./envSchema.js";

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

// A schema another file builds.
export function crossFile() {
  return AppEnv.parse(process.env);
}

// A refinement chained on a schema kept in a name.
const Base = z.object({ BASE_URL: z.string() });
const Strict = Base.strict();
export function namedRefinement() {
  return Strict.parse(process.env);
}

// A call named like a defaulting one, inside a function written in the key.
export function functionInKey() {
  return z
    .object({
      PORT_NUMBER: z
        .string()
        .transform((value) => Number(value ?? defaults.or(3))),
    })
    .parse(process.env);
}
const defaults = { or: (n: number) => n };

// The environment Vite gives the program.
export function viteEnv() {
  return z.object({ VITE_API: z.string() }).parse(import.meta.env);
}

// An envalid function imported under another name.
export function aliased() {
  return load(process.env, { ALIASED_KEY: str({ default: "x" }) });
}
