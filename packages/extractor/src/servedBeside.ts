/**
 * What a framework pack read that serves requests beside its routes,
 * written on every route the pack recognized in the run, and the part
 * of that every adapter reads the same way: the files a static
 * directory serves. The checker reports a call to a missing route only
 * in a service whose routes all have a statement from their pack.
 */

import fs from "node:fs";
import path from "node:path";

import { BOUNDARY_ROLE, withServedBesideMetadata } from "@suss/behavioral-ir";

import type { BehavioralSummary, ServedBesideEntry } from "@suss/behavioral-ir";

/** Writes the pack's statement on each unit the pack recognized that serves a boundary. */
export function stampServedBeside(
  summaries: readonly BehavioralSummary[],
  pack: string,
  entries: readonly ServedBesideEntry[],
): void {
  const statement = { pack, entries: [...entries] };
  for (const summary of summaries) {
    if (
      summary.identity.boundaryBinding?.recognition !== pack ||
      BOUNDARY_ROLE[summary.kind] !== "provider"
    ) {
      continue;
    }
    summary.metadata = withServedBesideMetadata(summary.metadata, statement);
  }
}

/**
 * The files each static directory serves for GET: a file at the top at
 * its own path, and a directory as every path under it. A directory is
 * read against `root` unless it is absolute.
 */
export function staticDirectoryEntries(
  root: string,
  directories: readonly string[],
): ServedBesideEntry[] {
  return directories.flatMap((directory) => {
    const at = path.resolve(root, directory);
    let names: fs.Dirent[];
    try {
      names = fs.readdirSync(at, { withFileTypes: true });
    } catch {
      return [];
    }
    return names.map((name) => ({
      by: "static" as const,
      path: name.isDirectory()
        ? `/${name.name.toLowerCase()}/{rest*}`
        : `/${name.name.toLowerCase()}`,
      methods: ["GET", "HEAD"],
      file: path.join(at, name.name),
      line: 1,
    }));
  });
}
