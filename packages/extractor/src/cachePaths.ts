/**
 * Paths in the extraction cache, written relative to the checkout.
 *
 * Worktrees of one repository share a cache, and what one checkout stored
 * refers to its own files by absolute path: the manifest's file list, the
 * summaries' locations, the paths in an adapter's records, and the paths
 * in the entry's key. Every stored file goes through here, so its text
 * has the checkout's root replaced by a placeholder on the way to disk
 * and the reading checkout's root put back on the way in. Two checkouts
 * with the same files then store the same text, under the same key and
 * the same shard names. Doing it on the text covers every field with a
 * path in it, including fields added later, which a list of fields would
 * not.
 */

import path from "node:path";

import { readJsonFile } from "@suss/behavioral-ir/files";

import { checkoutOf, rootAsSpelledBy } from "./checkout.js";

const RESOLVED = "\u0000checkout";
const AS_GIVEN = "\u0000checkout-as-given";
/** Added to a placeholder for the root percent-encoded, as a key with a file in it has it. */
const ENCODED = "-encoded";

export interface StoredPaths {
  /** The text an entry's key is hashed from, with the checkout's root as a placeholder. */
  keyText(text: string): string;
  /** A piece of a stored file's JSON text, the same way. */
  storedPiece(piece: string): string;
  /** A stored file's value, with this checkout's root back in its paths. */
  read(file: string): unknown;
}

/** For a run outside any checkout, which stores its paths as they are. */
export const PATHS_AS_THEY_ARE: StoredPaths = {
  keyText: (text) => text,
  storedPiece: (piece) => piece,
  read: (file) => readJsonFile(file),
};

/**
 * How a run stores paths, given one of the files it reads: relative to
 * the checkout that file is in, or as they are outside git. The cache and
 * an adapter's dependency hashes both go through it, so they agree.
 */
export function storedPathsOfRun(anchor: string | undefined): {
  paths: StoredPaths;
  root: string | null;
} {
  const checkout =
    anchor === undefined ? null : checkoutOf(path.dirname(anchor));
  const given =
    checkout === null || anchor === undefined
      ? null
      : rootAsSpelledBy(checkout, anchor);
  return checkout === null || given === null
    ? { paths: PATHS_AS_THEY_ARE, root: null }
    : { paths: storedPathsFor(checkout.root, given), root: checkout.root };
}

/**
 * Paths stored relative to a checkout whose root resolves to `resolved`
 * and which the run spells `given`. The two differ for a run reached
 * through a symlink. Each spelling has a placeholder of its own, written
 * as it is and percent-encoded.
 */
export function storedPathsFor(resolved: string, given: string): StoredPaths {
  const spellings: [string, string][] = [
    [resolved, RESOLVED],
    ...(given === resolved ? [] : [[given, AS_GIVEN] as [string, string]]),
  ];
  // One spelling can contain the other, as /private/tmp/x contains /tmp/x,
  // and the longer has to go first.
  spellings.sort(([a], [b]) => b.length - a.length);
  const encoded = spellings.map(
    ([spelling, placeholder]): RootSpelling => ({
      spelling: encodeURIComponent(spelling),
      placeholder: jsonText(placeholder + ENCODED),
      inName: /[\w.~%-]/,
      endsAt: endsEncodedPath,
    }),
  );
  const raw = spellings.map(
    ([spelling, placeholder]): RootSpelling => ({
      spelling,
      placeholder,
      inName: IN_NAME,
      endsAt: endsPath,
    }),
  );
  const json = spellings.map(
    ([spelling, placeholder]): RootSpelling => ({
      spelling: jsonText(spelling),
      placeholder: jsonText(placeholder),
      inName: IN_NAME,
      endsAt: endsPath,
    }),
  );
  // A placeholder that starts with another goes back first.
  const restore = [
    [AS_GIVEN + ENCODED, encodeURIComponent(given)],
    [AS_GIVEN, given],
    [RESOLVED + ENCODED, encodeURIComponent(resolved)],
    [RESOLVED, resolved],
  ].map(([from, to]) => [jsonText(from ?? ""), jsonText(to ?? "")] as const);
  // An adapter's dependency hashes put every fact atom through `keyText`,
  // and most have no path in them.
  const mentions = spellings.flatMap(([spelling]) => [
    spelling,
    encodeURIComponent(spelling),
  ]);
  const forKey = [...encoded, ...raw];
  // Every placeholder starts with this one.
  const placed = jsonText(RESOLVED);
  // Line by line, so a stored file too large for one string still reads.
  const restored = (text: string): string =>
    text.includes(placed)
      ? restore.reduce((line, [from, to]) => line.replaceAll(from, to), text)
      : text;
  return {
    keyText: (text) =>
      mentions.some((one) => text.includes(one))
        ? replacedEach(text, forKey)
        : text,
    storedPiece: (piece) => replacedEach(piece, [...encoded, ...json]),
    read: (file) => readJsonFile(file, restored),
  };
}

/**
 * One way a root is written, and the placeholder for it. The root is
 * replaced only where it starts a path, not in the middle of a longer
 * name, and where a separator or what ends a path in JSON text or in a
 * key follows it: a quote, a delimiter or the end.
 */
interface RootSpelling {
  spelling: string;
  placeholder: string;
  /** A character a name can have, so a root right after one is the end of a longer name. */
  inName: RegExp;
  endsAt(text: string, at: number): boolean;
}

const IN_NAME = /[\w.~@+%/-]/;

function endsPath(text: string, at: number): boolean {
  return at === text.length || /[/\\"',:;|=\s]/.test(text.charAt(at));
}

/** An encoded root is followed by an encoded separator. */
function endsEncodedPath(text: string, at: number): boolean {
  return (
    at === text.length ||
    text.startsWith("%2F", at) ||
    text.startsWith("%5C", at) ||
    /["',:;|=\s]/.test(text.charAt(at))
  );
}

function replacedEach(text: string, roots: readonly RootSpelling[]): string {
  return roots.reduce(replaced, text);
}

// A scan with indexOf, since a pattern that starts with a lookbehind is
// tried at every character of the text, which cost more than the rest of
// writing the cache.
function replaced(text: string, root: RootSpelling): string {
  const pieces: string[] = [];
  let kept = 0;
  let at = text.indexOf(root.spelling);
  while (at !== -1) {
    const end = at + root.spelling.length;
    if (startsAPath(text, at, root.inName) && root.endsAt(text, end)) {
      pieces.push(text.slice(kept, at), root.placeholder);
      kept = end;
      at = text.indexOf(root.spelling, end);
    } else {
      at = text.indexOf(root.spelling, at + 1);
    }
  }
  return kept === 0 ? text : pieces.join("") + text.slice(kept);
}

/**
 * What can come right before a path: the start, a character no name has,
 * or an escape in JSON text, as a NUL between the parts of an id is.
 */
function startsAPath(text: string, at: number, inName: RegExp): boolean {
  return (
    at === 0 ||
    !inName.test(text.charAt(at - 1)) ||
    /^\\u[0-9a-fA-F]{4}$/.test(text.slice(Math.max(0, at - 6), at)) ||
    /^\\[nrtbf]$/.test(text.slice(Math.max(0, at - 2), at))
  );
}

/** How a string is written inside JSON text, without its quotes. */
function jsonText(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}
