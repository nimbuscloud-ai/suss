// fileConvention.ts — discover units in files whose place in the tree
// says what they are, which is how Next.js describes a route handler.

import picomatch from "picomatch";

import { discoverNamedExports } from "./namedExport.js";

import type { DiscoveryPattern } from "@suss/extractor";
import type { SourceFile } from "ts-morph";
import type { ResolutionStore } from "../facts/store.js";
import type { DiscoveredUnit } from "./shared.js";

type FileConvention = Extract<
  DiscoveryPattern["match"],
  { type: "fileConvention" }
>;

/**
 * Compiled matchers, keyed by the pattern text. Discovery runs the same
 * pattern against every file in the project, and compiling a glob costs
 * more than testing one.
 */
const matchers = new Map<string, (path: string) => boolean>();

function matcherFor(pattern: string): (path: string) => boolean {
  const existing = matchers.get(pattern);
  if (existing !== undefined) {
    return existing;
  }
  // A file path is absolute, so any hidden directory above the project
  // (a cache, a worktree, .next) sits in it. Without this the pattern
  // matches nothing and the pack finds nothing, with no diagnostic.
  const compiled = picomatch(pattern, { dot: true });
  matchers.set(pattern, compiled);
  return compiled;
}

/**
 * Units in a file the pattern names. The exports are found the same way
 * a `namedExport` pattern finds them; the file pattern decides which
 * files get asked at all, so a project's own function called `GET` in
 * some helper module stays out of it.
 */
export function discoverFileConventions(
  sourceFile: SourceFile,
  match: FileConvention,
  kind: string,
  resolution?: ResolutionStore,
): DiscoveredUnit[] {
  if (!matcherFor(match.filePattern)(sourceFile.getFilePath())) {
    return [];
  }
  return discoverNamedExports(
    sourceFile,
    { type: "namedExport", names: match.exportNames },
    kind,
    resolution,
  );
}
