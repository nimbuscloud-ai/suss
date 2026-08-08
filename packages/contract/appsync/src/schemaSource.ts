// schemaSource.ts: Resolve an API's declared schema source to SDL text.
//
// Inline SDL is already text. A `DefinitionS3Location` / `SchemaUri`
// pointing at a local file is loaded from disk via the SDL machinery in
// @suss/contract-graphql (relative paths resolve against the template's
// directory). A genuinely-remote `s3://` / `http(s)://` URI can't be
// fetched by a static reader, so it surfaces as an explicit unresolved
// gap rather than silently producing no schema.

import path from "node:path";

import { loadSdlFile } from "@suss/contract-graphql";

import type { RawSchemaSource } from "./cfn.js";

export type ResolvedSchema =
  | { status: "inline"; sdl: string }
  | { status: "external-file"; sdl: string; location: string }
  | {
      status: "unresolved";
      location: string;
      reason: "remote" | "not-found" | "no-base-dir";
    }
  | { status: "absent" };

/** Schemes a static reader can't dereference, recorded, never fetched. */
const REMOTE_SCHEME = /^(s3|https?):\/\//i;

/**
 * Resolve a raw schema source against a base directory (the template's
 * directory, or null for in-memory templates with no on-disk anchor).
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
