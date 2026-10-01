/**
 * Finds the contract files that repeat what another file already declares.
 *
 * A project can keep one spec as several files: a split source, a bundle
 * built from it, and a file per tag group that points at the same paths.
 * Read side by side, each file provides every boundary it shares with the
 * others, and every finding on one boundary is reported once per file.
 * `init` prints a command for one file of each set.
 *
 * A file counts as a copy only when every boundary in it is in the other
 * file with the same inputs and transitions. Two specs that describe one
 * operation differently, such as a served spec that has gone stale, are
 * both kept, since the difference is what a check is for.
 */

import fs from "node:fs";
import path from "node:path";

import { pairingKey } from "@suss/ir-core";

import type { BehavioralSummary } from "@suss/behavioral-ir";

/** What each boundary in a contract file says, by pairing key. */
export type ContentByBoundary = ReadonlyMap<string, string>;

interface ContractFile {
  name: string;
  file?: string;
}

/** Null when a summary lacks a pairing key, so the file cannot be compared. */
export function contentByBoundary(
  summaries: ReadonlyArray<BehavioralSummary>,
): ContentByBoundary | null {
  const content = new Map<string, string>();
  for (const summary of summaries) {
    const binding = summary.identity.boundaryBinding;
    const key =
      binding === null || binding === undefined ? null : pairingKey(binding);
    if (key === null) {
      return null;
    }
    const said = contentOf(summary);
    const earlier = content.get(key);
    content.set(key, earlier === undefined ? said : `${earlier}\n${said}`);
  }
  return content;
}

/** A summary's inputs and transitions, without where in the file each one is. */
function contentOf(summary: BehavioralSummary): string {
  return JSON.stringify(
    {
      inputs: summary.inputs,
      transitions: summary.transitions.map(
        ({ location: _location, ...rest }) => rest,
      ),
    },
    withNestedUnionsFlattened,
  );
}

/** A bundler that inlines a `$ref` can leave a union inside a union, which says the same as one union. */
function withNestedUnionsFlattened(_key: string, value: unknown): unknown {
  if (!isUnion(value)) {
    return value;
  }
  return { ...value, variants: variantsOf(value) };
}

interface Union {
  type: "union";
  variants: unknown[];
}

function isUnion(value: unknown): value is Union {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "union" &&
    Array.isArray((value as { variants?: unknown }).variants)
  );
}

function variantsOf(union: Union): unknown[] {
  return union.variants.flatMap((variant) =>
    isUnion(variant) ? variantsOf(variant) : [variant],
  );
}

/**
 * Each file whose boundaries another file read by the same reader also
 * declares, the same way, with the file that is kept in its place.
 */
export function contractsCoveredByAnother<File extends ContractFile>(
  root: string,
  read: ReadonlyMap<File, ContentByBoundary | null>,
): Array<{ suggestion: File; coveredBy: string }> {
  const comparable = [...read].flatMap(([suggestion, content]) =>
    content === null || suggestion.file === undefined
      ? []
      : [
          {
            suggestion,
            file: suggestion.file,
            content,
            bytes: sizeOf(path.join(root, suggestion.file)),
          },
        ],
  );
  type Comparable = (typeof comparable)[number];
  const covers = (other: Comparable, one: Comparable): boolean =>
    other !== one &&
    other.suggestion.name === one.suggestion.name &&
    saysAllOf(other.content, one.content) &&
    (other.content.size > one.content.size || keptBefore(other, one));
  const kept = comparable.filter(
    (one) => !comparable.some((other) => covers(other, one)),
  );

  return comparable.flatMap((one) => {
    const by = kept.find((other) => covers(other, one));
    return by === undefined
      ? []
      : [{ suggestion: one.suggestion, coveredBy: by.file }];
  });
}

function saysAllOf(
  large: ContentByBoundary,
  small: ContentByBoundary,
): boolean {
  for (const [key, said] of small) {
    if (large.get(key) !== said) {
      return false;
    }
  }
  return true;
}

/**
 * Of two files with the same boundaries, whether `a` is the one kept. A
 * file nearer the top is the entry point a person opens first, and of two
 * at one depth, a bundle is the larger.
 */
function keptBefore(
  a: { file: string; bytes: number },
  b: { file: string; bytes: number },
): boolean {
  const depthA = a.file.split(path.sep).length;
  const depthB = b.file.split(path.sep).length;
  if (depthA !== depthB) {
    return depthA < depthB;
  }

  if (a.bytes !== b.bytes) {
    return a.bytes < b.bytes;
  }
  return a.file < b.file;
}

function sizeOf(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}
