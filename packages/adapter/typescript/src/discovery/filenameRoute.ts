// filenameRoute.ts — turn the place a file sits into the route path it
// serves, following the convention its pack declares.

import type { BindingExtraction } from "@suss/extractor";

type FilenameRoute = Extract<
  BindingExtraction["path"],
  { type: "fromFilename" }
>;

/**
 * The route a file serves, or null when the file sits outside the root
 * the pack named. Placeholders come out in `{name}` form, which the
 * checker's path comparison already treats as equal to `:name`.
 */
export function routePathFromFile(
  filePath: string,
  convention: FilenameRoute,
): string | null {
  const belowRoot = segmentsBelowRoot(filePath, convention.root);
  if (belowRoot === null) {
    return null;
  }

  const parts: string[] = [];
  for (const segment of belowRoot) {
    for (const part of splitSegment(segment, convention)) {
      const rewritten = rewriteSegment(part, convention);
      if (rewritten !== null) {
        parts.push(rewritten);
      }
    }
  }
  return `/${parts.join("/")}`;
}

/**
 * The parts of the path below the root directory, with the file
 * extension taken off the last one. Null when the root never appears.
 */
function segmentsBelowRoot(filePath: string, root: string): string[] | null {
  const all = filePath.split("/").filter((s) => s.length > 0);
  const rootParts = root.split("/").filter((s) => s.length > 0);

  // Search from the end, so a project that keeps its app directory
  // inside another one named the same way still resolves against the
  // innermost match.
  for (let start = all.length - rootParts.length; start >= 0; start--) {
    const matches = rootParts.every((part, i) => all[start + i] === part);
    if (!matches) {
      continue;
    }
    const below = all.slice(start + rootParts.length);
    if (below.length === 0) {
      return null;
    }
    const last = below[below.length - 1];
    below[below.length - 1] = last.replace(/\.[^.]+$/, "");
    return below;
  }
  return null;
}

/** A flat route holds its whole path in one filename, split on dots. */
function splitSegment(segment: string, convention: FilenameRoute): string[] {
  return convention.flat === true ? segment.split(".") : [segment];
}

/**
 * One path segment, or null when the framework drops it: a filename
 * naming the file's role, a directory in parentheses that only groups
 * files.
 */
function rewriteSegment(
  segment: string,
  convention: FilenameRoute,
): string | null {
  if (segment.length === 0) {
    return null;
  }
  if ((convention.dropBasenames ?? []).includes(segment)) {
    return null;
  }
  if (
    convention.dropParenthesized === true &&
    segment.startsWith("(") &&
    segment.endsWith(")")
  ) {
    return null;
  }
  return parameterName(segment, convention) ?? segment;
}

/**
 * The parameter a segment declares, or null when it declares none.
 * A catch-all (`[...slug]`) comes out as the plain name, so a route
 * matching many segments looks like one matching a single segment.
 */
function parameterName(
  segment: string,
  convention: FilenameRoute,
): string | null {
  if (convention.dynamic === "brackets") {
    const inner = segment.replace(/^\[+/, "").replace(/\]+$/, "");
    if (inner === segment) {
      return null;
    }
    return `{${inner.replace(/^\.\.\./, "")}}`;
  }
  if (convention.dynamic === "dollarPrefix" && segment.startsWith("$")) {
    return `{${segment.slice(1)}}`;
  }
  return null;
}
