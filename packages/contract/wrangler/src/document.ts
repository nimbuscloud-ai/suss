/**
 * Finding and parsing a Wrangler configuration document.
 *
 * Wrangler accepts the same configuration in two spellings, TOML and
 * JSONC, and prefers the JSON one where a project has both. This module
 * settles which file a path means and hands back the parsed object; the
 * shape of what is in it is `translate.ts`'s problem.
 */

import fs from "node:fs";
import path from "node:path";

import { parse as parseJsonc } from "jsonc-parser";
import { parse as parseToml } from "smol-toml";

/**
 * The names Wrangler looks for, in the order it prefers them. Wrangler
 * defines the list, so a project that spells its file otherwise passes
 * the path to that file outright.
 */
export const CONFIGURATION_FILE_NAMES = [
  "wrangler.jsonc",
  "wrangler.json",
  "wrangler.toml",
];

/** Whether a file is one Wrangler would read as a Worker's configuration. */
export function isConfigurationFile(basename: string): boolean {
  return CONFIGURATION_FILE_NAMES.includes(basename);
}

/** One binding a Worker is given, as Wrangler writes it. */
export type WranglerRecord = Record<string, unknown>;

/**
 * A parsed Wrangler document, top-level and per-environment alike. The
 * fields are Wrangler's own names, and everything is optional because
 * every one of them is optional in the file.
 */
export interface WranglerDocument {
  name?: string;
  main?: string;
  vars?: Record<string, unknown>;
  kv_namespaces?: WranglerRecord[];
  r2_buckets?: WranglerRecord[];
  d1_databases?: WranglerRecord[];
  queues?: {
    producers?: WranglerRecord[];
    consumers?: WranglerRecord[];
  };
  env?: Record<string, WranglerDocument>;
  [key: string]: unknown;
}

export type DocumentLocation =
  | { kind: "file"; file: string }
  | { kind: "missing" };

/**
 * The configuration file a path means. A path may be the file itself or
 * the directory a Worker lives in, since that is where a person points
 * when they mean the Worker rather than one of its two spellings.
 */
export function locateConfigurationFile(target: string): DocumentLocation {
  const resolved = path.resolve(target);
  if (!fs.existsSync(resolved)) {
    return { kind: "missing" };
  }
  if (fs.statSync(resolved).isFile()) {
    return { kind: "file", file: resolved };
  }
  for (const name of CONFIGURATION_FILE_NAMES) {
    const candidate = path.join(resolved, name);
    if (fs.existsSync(candidate)) {
      return { kind: "file", file: candidate };
    }
  }
  return { kind: "missing" };
}

/** The document a file contains, read by whichever parser its suffix asks for. */
export function loadConfigurationDocument(file: string): WranglerDocument {
  const text = fs.readFileSync(file, "utf8");
  const parsed = file.endsWith(".toml")
    ? (parseToml(text) as unknown)
    : (parseJsonc(text) as unknown);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${file} does not contain a Wrangler configuration object`);
  }
  return parsed as WranglerDocument;
}
