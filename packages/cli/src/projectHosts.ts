/**
 * The hosts `suss.json` says the project serves, listed under `hosts`.
 *
 * A client that writes out a public host, as in
 * `https://api.example.com/orders`, is calling another company's API
 * unless the project says the host is its own. Pairing never puts such a
 * call against the project's routes. Listing the host here says the call
 * goes to this project, so `extract` leaves the host off it and it pairs
 * the way a relative URL does.
 */

import fs from "node:fs";
import path from "node:path";

import { withoutOwnHost } from "@suss/behavioral-ir";

import { nearestProjectFile } from "./projectModules.js";
import { UsageError } from "./usageError.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";

/**
 * The hosts the nearest `suss.json` at or above `start` lists, lowercased.
 * Empty when there is no such file, it does not parse, or it lists none.
 */
export function projectHosts(start: string): ReadonlySet<string> {
  const file = nearestProjectFile(path.resolve(start));
  if (file === null) {
    return new Set();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return new Set();
  }
  const hosts = (parsed as { hosts?: unknown } | null)?.hosts;
  if (hosts === undefined) {
    return new Set();
  }
  if (
    !Array.isArray(hosts) ||
    !hosts.every((host) => typeof host === "string" && host !== "")
  ) {
    throw new UsageError(
      `${file}: "hosts" has to be a list of host names, such as ["api.example.com"].`,
    );
  }
  return new Set(hosts.map((host: string) => host.toLowerCase()));
}

/** Leaves the host off a call to one the project serves. */
export function forgetOwnHosts(
  summary: BehavioralSummary,
  hosts: ReadonlySet<string>,
): void {
  const binding = summary.identity.boundaryBinding;
  if (binding !== null && binding !== undefined && hosts.size > 0) {
    summary.identity.boundaryBinding = withoutOwnHost(binding, hosts);
  }
}
