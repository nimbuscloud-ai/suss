// Turns an API's declared schema source into SDL text. A remote `s3://`
// or `http(s)://` URI cannot be fetched by a static reader, so it becomes
// an unresolved source and the missing schema shows up in the summary.

import path from "node:path";

import { loadSdlFile } from "@suss/contract-graphql";

import type { RawSchemaSource } from "./cfn.js";

export type ResolvedSchema =
  | { status: "inline"; sdl: string }
  | { status: "external-file"; sdl: string; location: string }
  | {
      status: "unresolved";
      location: string | null;
      reason: "remote" | "not-found" | "no-base-dir" | "computed";
    }
  | { status: "absent" };

/** URI schemes that are recorded and never fetched. */
const REMOTE_SCHEME = /^(s3|https?):\/\//i;

/**
 * Resolves a schema source to SDL. `baseDir` is the template's directory,
 * or null for a template with no file on disk.
 */
export function resolveSchemaSource(
  raw: RawSchemaSource,
  baseDir: string | null,
): ResolvedSchema {
  if (raw.kind === "inline") {
    return { status: "inline", sdl: raw.sdl };
  }
  if (raw.kind === "absent") {
    return { status: "absent" };
  }

  // An intrinsic computes the location, so there is no path to open,
  // though the deployed API still has a schema.
  if (raw.kind === "computed") {
    return { status: "unresolved", location: null, reason: "computed" };
  }

  return resolveLocation(raw.location, baseDir);
}

function resolveLocation(
  location: string,
  baseDir: string | null,
): ResolvedSchema {
  if (REMOTE_SCHEME.test(location)) {
    return { status: "unresolved", location, reason: "remote" };
  }
  const resolvedPath = toLocalPath(location, baseDir);
  if (resolvedPath === null) {
    return { status: "unresolved", location, reason: "no-base-dir" };
  }
  const sdl = loadSdlFile(resolvedPath);
  if (sdl === null) {
    return { status: "unresolved", location, reason: "not-found" };
  }
  return { status: "external-file", sdl, location };
}

function toLocalPath(location: string, baseDir: string | null): string | null {
  if (path.isAbsolute(location)) {
    return location;
  }
  if (baseDir === null) {
    return null;
  }
  return path.resolve(baseDir, location);
}

/** The SDL text when the source resolved to any, else null. */
export function resolvedSdl(resolved: ResolvedSchema): string | null {
  if (resolved.status === "inline" || resolved.status === "external-file") {
    return resolved.sdl;
  }
  return null;
}
