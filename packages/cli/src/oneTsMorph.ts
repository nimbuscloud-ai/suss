/**
 * Checks that every pack in a run imports the same ts-morph that the
 * TypeScript adapter parses with.
 *
 * A pack tests nodes with calls such as `Node.isPropertyAccessExpression`,
 * which compare the node's kind number with the `SyntaxKind` of the copy
 * the pack imported. TypeScript renumbers those kinds between versions,
 * so a pack with a second copy never matches a call. No error is raised,
 * and the output looks like a project that does not use the library.
 *
 * npm installs a second copy when a pack's peer range and the adapter's
 * dependency range resolve to different versions. A user's own ts-morph
 * can cause this, so the run prints a warning when it finds one.
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

/** The version of ts-morph that a file at this path would import. */
function versionSeenFrom(fromFile: string): string | null {
  try {
    const manifest = createRequire(fromFile).resolve("ts-morph/package.json");
    const version = JSON.parse(fs.readFileSync(manifest, "utf8")).version;
    return typeof version === "string" ? version : null;
  } catch {
    return null;
  }
}

/** The path of a pack's entry file, so its imports can be resolved from there. */
function packEntry(specifier: string): string | null {
  try {
    return fileURLToPath(import.meta.resolve(specifier));
  } catch {
    return null;
  }
}

/**
 * Compares the ts-morph each pack resolves with the one this run parses
 * with. A pack whose ts-morph version cannot be read is left out, so the
 * warning never reports a mismatch it could not confirm.
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

/** The warning to print when a pack imports a different ts-morph, or "" when none does. */
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
