/**
 * The rival: could a person find each traced edge by reading the file
 * that handles the route?
 *
 * The handler's file comes from the span when the instrumentation says
 * where the handler is, from the files suss lists for the route
 * (its own and its wrappers'), and otherwise from a text search for a
 * line that registers the route's last fixed path segment. The edge
 * counts as found when the file mentions the table, host or destination,
 * with the same model and table name rule suss gets.
 */

import path from "node:path";

import { nameKey } from "./agreement.js";
import { entryKey, targetKey } from "./edges.js";

import type { RouteEntry, Target, TracedEdge } from "./edges.js";
import type { SourceTree } from "./sourceTree.js";
import type { RouteMatch } from "./sussSide.js";

export type Locator = "trace" | "suss" | "search";

export interface GrepVerdict {
  edge: string;
  found: boolean;
  located: Locator | null;
  files: string[];
}

// A line that registers a route says so with one of these words.
const REGISTRATION =
  /\b(get|post|put|patch|delete|route|router|resources?|resource|match|api_route|add_api_route)\b/i;

const MOST_FILES_SEARCHED = 10;

function fromTrace(entry: RouteEntry, tree: SourceTree): string[] {
  if (entry.code.file !== undefined) {
    return tree
      .endingWith(path.basename(entry.code.file))
      .filter((file) => file.endsWith(entry.code.file ?? ""));
  }
  const namespace = entry.code.namespace?.split(/::|\./).pop();
  if (namespace === undefined) {
    return [];
  }
  const declares = new RegExp(`\\bclass\\s+${namespace}\\b`);
  return tree.files.filter((file) => declares.test(tree.text(file)));
}

interface WrapperMetadata {
  wrappers?: { applied?: Array<{ file?: string }> };
}

function fromSuss(match: RouteMatch | undefined, tree: SourceTree): string[] {
  const relative = new Set<string>();
  for (const route of match?.routes ?? []) {
    for (const summary of route.summaries) {
      relative.add(summary.location.file);
      const metadata = summary.metadata as WrapperMetadata | undefined;
      for (const wrapper of metadata?.wrappers?.applied ?? []) {
        if (wrapper.file !== undefined) {
          relative.add(wrapper.file);
        }
      }
    }
  }
  return [...relative].flatMap((file) => tree.endingWith(file));
}

function fromSearch(entry: RouteEntry, tree: SourceTree): string[] {
  const fixed = entry.route
    .split("/")
    .filter((segment) => segment !== "" && !/[:{*(]/.test(segment));
  const last = fixed[fixed.length - 1];
  if (last === undefined) {
    return [];
  }
  const literal = new RegExp(
    `['"\`][^'"\`\\n]*\\b${last.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b[^'"\`\\n]*['"\`]|:${last}\\b`,
  );
  const found = tree.files.filter((file) =>
    tree
      .text(file)
      .split("\n")
      .some((line) => REGISTRATION.test(line) && literal.test(line)),
  );
  return found.length > MOST_FILES_SEARCHED ? [] : found;
}

function mentions(target: Target, text: string): boolean {
  if (target.kind === "storage") {
    const wanted = nameKey(target.table);
    return (text.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []).some(
      (token) => nameKey(token) === wanted,
    );
  }
  return text.includes(
    target.kind === "http" ? target.host : target.destination,
  );
}

function firstLocated(tries: ReadonlyArray<[Locator, () => string[]]>): {
  files: string[];
  by: Locator | null;
} {
  for (const [by, find] of tries) {
    const files = find();
    if (files.length > 0) {
      return { files, by };
    }
  }
  return { files: [], by: null };
}

export function grepEdges(
  edges: readonly TracedEdge[],
  routesMatched: ReadonlyMap<string, RouteMatch>,
  tree: SourceTree,
): GrepVerdict[] {
  const located = new Map<string, { files: string[]; by: Locator | null }>();
  const locate = (
    entry: RouteEntry,
  ): { files: string[]; by: Locator | null } => {
    const key = entryKey(entry);
    const known = located.get(key);
    if (known !== undefined) {
      return known;
    }
    const result = firstLocated([
      ["trace", () => fromTrace(entry, tree)],
      ["suss", () => fromSuss(routesMatched.get(key), tree)],
      ["search", () => fromSearch(entry, tree)],
    ]);
    located.set(key, result);
    return result;
  };
  return edges.map((edge) => {
    const { files, by } = locate(edge.entry);
    return {
      edge: `${entryKey(edge.entry)} -> ${targetKey(edge.target)}`,
      found: files.some((file) => mentions(edge.target, tree.text(file))),
      located: by,
      files: files.map((file) => path.relative(tree.root, file)),
    };
  });
}
