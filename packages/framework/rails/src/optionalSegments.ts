/**
 * Rails writes an optional part of a route path in parentheses.
 * `scope "(/locale/:locale)"` serves `/articles` and
 * `/locale/:locale/articles` alike, and `get "feed(.:format)"` serves
 * `/feed` and `/feed.:format`. A client calls one of those plain paths,
 * so the route's path is written as a set of every path the groups
 * allow: `/(|locale/:locale/)articles`. A group can contain another.
 */

import { setPiece } from "@suss/ir-core";

/** Past this many paths, the groups read so far are all left out, which still leaves a path the route serves. */
const EXPANSION_CAP = 64;

/** The end of the group opened at `open`, or -1 when it never closes. */
function closingParenthesis(text: string, open: number): number {
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    const char = text[index];
    if (char === "(") {
      depth += 1;
    }
    if (char === ")") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}

/** Every text the groups in `text` allow, with each group's absence first. Null when a parenthesis is unmatched. */
function expansions(text: string): string[] | null {
  let found = [""];
  let index = 0;
  while (index < text.length) {
    const open = text.indexOf("(", index);
    const close = text.indexOf(")", index);
    if (close !== -1 && (open === -1 || close < open)) {
      return null;
    }
    if (open === -1) {
      const rest = text.slice(index);
      found = found.map((prefix) => prefix + rest);
      break;
    }
    const end = closingParenthesis(text, open);
    const inner = end === -1 ? null : expansions(text.slice(open + 1, end));
    if (inner === null) {
      return null;
    }
    const before = text.slice(index, open);
    const options = ["", ...inner];
    found = found.flatMap((prefix) =>
      options.map((option) => prefix + before + option),
    );
    if (found.length > EXPANSION_CAP) {
      found = found.slice(0, 1);
    }
    index = end + 1;
  }
  return found;
}

/** One leading slash, none doubled, none trailing: what Rails makes of each path a group allows. */
function tidied(path: string): string {
  const squeezed = `/${path}`.replace(/\/{2,}/g, "/");
  return squeezed.length > 1 ? squeezed.replace(/\/$/, "") : squeezed;
}

function segmentsOf(path: string): string[] {
  return path === "/" ? [] : path.slice(1).split("/");
}

/** How many segments every list shares, counted from the front or, with `fromEnd`, from the back. */
function sharedCount(
  lists: readonly string[][],
  limit: number,
  fromEnd: boolean,
): number {
  const first = lists[0] ?? [];
  const at = (list: readonly string[], offset: number): string | undefined =>
    fromEnd ? list[list.length - 1 - offset] : list[offset];
  let count = 0;
  while (
    count < limit &&
    lists.every((list) => at(list, count) === at(first, count))
  ) {
    count += 1;
  }
  return count;
}

/**
 * The paths written as one, with the segments they all share kept
 * outside the set: `/api(|/v1)/users` rather than a set of two whole
 * paths. Null when an option cannot be written inside a set.
 */
function asOnePath(paths: readonly string[]): string | null {
  const lists = paths.map(segmentsOf);
  const shortest = Math.min(...lists.map((list) => list.length));
  const headCount = sharedCount(lists, shortest, false);
  const tailCount = sharedCount(lists, shortest - headCount, true);
  const first = lists[0] ?? [];
  const head = first.slice(0, headCount).join("/");
  const tail = first.slice(first.length - tailCount).join("/");
  const middles = lists.map((list) =>
    list.slice(headCount, list.length - tailCount).join("/"),
  );
  if (head !== "") {
    const set = setPiece(middles.map((middle) => (middle ? `/${middle}` : "")));
    return set === null ? null : `/${head}${set}${tail ? `/${tail}` : ""}`;
  }
  const set = setPiece(
    middles.map((middle) => (middle && tail ? `${middle}/` : middle)),
  );
  return set === null ? null : `/${set}${tail}`;
}

/**
 * The route path with its optional groups written as the set of paths
 * they allow. A path with no group comes back as it is, and so does one
 * whose parentheses do not balance.
 */
export function pathWithOptionalGroups(path: string): string {
  if (!path.includes("(")) {
    return path;
  }
  const expanded = expansions(path);
  if (expanded === null) {
    return path;
  }
  const paths = [...new Set(expanded.map(tidied))];
  const withoutGroups = paths[0] ?? path;
  if (paths.length === 1) {
    return withoutGroups;
  }
  return asOnePath(paths) ?? withoutGroups;
}
