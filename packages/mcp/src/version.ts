/**
 * The version this package was published at.
 *
 * npm sets `npm_package_version` only when it runs a script, and a host
 * that starts the binary directly sets no such variable. So the version
 * comes from the package manifest, which ships beside the build.
 */

import fs from "node:fs";

/** Fall back to this when the manifest cannot be read at all. */
export const UNKNOWN_VERSION = "0.0.0";

/**
 * The version the manifest at `manifestUrl` states.
 *
 * A published package always has one beside its build. A partial
 * checkout may not, and there a server that starts and reports an
 * unknown version is more useful than one that refuses to start.
 */
export function versionFrom(manifestUrl: URL): string {
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestUrl, "utf8")) as {
      version?: string;
    };
    return manifest.version ?? UNKNOWN_VERSION;
  } catch {
    return UNKNOWN_VERSION;
  }
}
