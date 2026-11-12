/**
 * What a Worker reads off the bindings its trigger is handed. A read of
 * `env.SOME_VAR` is a config read, recorded the way `@suss/runtime-node`
 * records `process.env.X`, so `checkRuntimeConfig` pairs it with whatever
 * `wrangler.toml` declares. Every read is spelled `env.<name>`, whatever
 * the project calls the parameter, so a reader sees one channel.
 */

import { handedIn, runtimeReads } from "@suss/recognize";

import { ENV } from "./triggers.js";

import type { Deployment } from "@suss/recognize";

/** A read off a trigger's bindings, for the Worker `deployment` says. */
export function envReads(deployment: Deployment) {
  return runtimeReads({ object: handedIn(ENV), deployment })
    .entries({}, { reads: "config" })
    .example('env.GREETING_TABLE ?? "greetings"');
}
