/**
 * Whether every pack in this run sees the same ts-morph the adapter
 * parses with.
 *
 * A pack asks ts-morph questions about nodes the adapter's parser made:
 * `Node.isPropertyAccessExpression(callee)` and the like. Each of those
 * compares the node's kind number against the `SyntaxKind` of whichever
 * copy the pack imported, and TypeScript moves those numbers between
 * versions. So a pack holding a second copy says no to every question,
 * never matches a call, and reports no error, which reads exactly like
 * a project that does not use the library.
 *
 * npm installs a second copy whenever a pack's peer range and the
 * adapter's dependency range can be satisfied by two different
 * versions. The published packages did that until the ranges were made
 * to agree, and a user's own ts-morph can still do it, so the run says
 * what it found rather than going quiet.
 */

import fs from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

/** A pack whose ts-morph is not the one the adapter parses with. */
export interface SecondCopy {
  pack: string;
  version: string;
}

export interface TsMorphCheck {
  /** The version this run parses with, or null when it cannot be read. */
  ours: string | null;
  others: SecondCopy[];
}

/** The ts-morph a file at this path would import, by version. */
function versionSeenFrom(fromFile: string): string | null {
  try {
    const manifest = createRequire(fromFile).resolve("ts-morph/package.json");
    const version = JSON.parse(fs.readFileSync(manifest, "utf8")).version;
    return typeof version === "string" ? version : null;
  } catch {
    return null;
  }
}

/** Where a pack's own files are, for resolving what it imports. */
function packEntry(specifier: string): string | null {
  try {
    return fileURLToPath(import.meta.resolve(specifier));
  } catch {
    return null;
  }
}

/**
 * The ts-morph each pack resolves, against the one this run parses
 * with. A pack whose copy cannot be read is left out, since a
 * diagnostic that guesses is worse than one that stays quiet.
 */
export function checkOneTsMorph(
  packs: ReadonlyArray<{ name: string; specifier: string }>,
): TsMorphCheck {
  const ours = versionSeenFrom(fileURLToPath(import.meta.url));
  if (ours === null) {
    return { ours: null, others: [] };
  }

  const others: SecondCopy[] = [];
  const seen = new Set<string>();
  for (const { name, specifier } of packs) {
    if (seen.has(name)) {
      continue;
    }
    seen.add(name);
    const entry = packEntry(specifier);
    const theirs = entry === null ? null : versionSeenFrom(entry);
    if (theirs !== null && theirs !== ours) {
      others.push({ pack: name, version: theirs });
    }
  }
  return { ours, others };
}

/** What to print when a pack found a different ts-morph, or "". */
export function formatSecondCopies(check: TsMorphCheck): string {
  if (check.ours === null || check.others.length === 0) {
    return "";
  }
  return [
    "",
    `These packs read a different ts-morph than this run parses with (${check.ours}):`,
    ...check.others.map(
      (other) => `    ${other.pack} imports ts-morph ${other.version}`,
    ),
    "  A pack asks ts-morph what shape a node is, and two copies disagree",
    "  about the numbers behind those questions, so these packs never match",
    "  a call. Installing suss and its packs at one version gives them one",
    "  copy of ts-morph.",
    "",
  ].join("\n");
}
