/**
 * version.ts: the version this package was published at.
 *
 * npm sets `npm_package_version` only when it runs a script. A host
 * that starts the binary sets no such variable, so every client asking
 * a server for its version used to be told `0.0.0-dev`. The manifest
 * beside the build says it, and it ships with the package.
 */

import fs from "node:fs";

/** Fall back to this when the manifest cannot be read at all. */
export const UNKNOWN_VERSION = "0.0.0";

/**
 * The version the manifest at `manifestUrl` states.
 *
 * A published package always has one beside its build. A checkout that
 * somebody has taken apart may not, and a server that still starts and
 * reports an unknown version is better there than one that refuses to.
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
