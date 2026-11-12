/**
 * Where a Worker's triggers are: the members of the object its entrypoint
 * default-exports, and the older `addEventListener("fetch", handler)`
 * form. Both are declared patterns that every adapter reads through its
 * module ops, so a trigger written elsewhere and referred to by name, or
 * imported and spread in, is followed to its function.
 *
 * A trigger on the exported object is handed its bindings as its second
 * parameter, and its unit says so with `handedIn`, so the env chain reads
 * them whatever the parameter is called. A listener is handed the event
 * alone.
 */

import { global } from "@suss/recognize";

import { TRIGGERS } from "./handlers.js";

import type { DeclaredDiscoveryPattern, UnitSpec } from "@suss/extractor";

/** Metadata namespace stamped on every unit this pack discovers. */
export const METADATA_NAMESPACE = "cloudflareWorkers";

/** How a trigger was registered, recorded so a reader can tell them apart. */
type Registration = "default-export" | "addEventListener";

/** The name the env chain asks for a trigger's bindings under. */
export const ENV = "env";

/** Every trigger on the exported object takes its event first and its bindings second. */
const ENV_AT = 1;

/** The unit each trigger name becomes, for the form it was registered in. */
function specs(
  registration: Registration,
  scriptName: string | undefined,
): Record<string, UnitSpec> {
  return Object.fromEntries(
    Object.entries(TRIGGERS).map(([trigger, shape]) => [
      trigger,
      {
        kind: shape.kind,
        name: trigger,
        ...(shape.routeInfo === undefined
          ? {}
          : { routeInfo: shape.routeInfo }),
        ...(shape.channelInfo === undefined
          ? {}
          : { channelInfo: shape.channelInfo }),
        ...(scriptName === undefined
          ? {}
          : {
              deployableUnit: {
                deploymentTarget: "worker" as const,
                instanceName: scriptName,
              },
            }),
        ...(registration === "default-export"
          ? { handedIn: [{ at: ENV_AT, name: ENV }] }
          : {}),
        metadata: { [METADATA_NAMESPACE]: { trigger, registration } },
      },
    ]),
  );
}

/** The triggers the entrypoint's default export defines, one unit per member. */
export function entrypointObject(
  scriptName: string | undefined,
): DeclaredDiscoveryPattern {
  return {
    kind: "handler",
    match: {
      type: "namedExport",
      names: ["default"],
      members: { named: specs("default-export", scriptName) },
    },
  };
}

/** The service-worker form, registered in the module body. */
export function listener(
  scriptName: string | undefined,
): DeclaredDiscoveryPattern {
  return {
    kind: "handler",
    match: {
      type: "registeredFunction",
      start: global("addEventListener"),
      handler: { at: 1 },
      nameAt: { at: 0, named: specs("addEventListener", scriptName) },
    },
  };
}
