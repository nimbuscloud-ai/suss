/**
 * Disagreements suss keeps on purpose, or cannot fix in the packs. A
 * case that disagrees and matches a gap does not fail the run. A gap
 * that no case still disagrees on does fail it, so the list loses an
 * entry as soon as a fix makes the entry wrong.
 */

import type { Library, UrlCase } from "./cases.js";

export interface KnownGap {
  readonly libraries: readonly Library[];
  /** The base and path kinds the gap covers. A missing list covers every kind. */
  readonly baseKinds?: readonly string[];
  readonly pathKinds?: readonly string[];
  readonly reason: string;
}

export const KNOWN_GAPS: readonly KnownGap[] = [
  {
    libraries: ["httpx", "axios"],
    baseKinds: ["query", "querySlash"],
    reason:
      "httpx and axios write the call's path after the base's query, so the request goes to the base's path with the path inside the query. Nobody writes a base like that on purpose, and suss reads the path a reader would expect.",
  },
  {
    libraries: ["httpx", "aiohttp", "axios"],
    pathKinds: ["schemeRelative"],
    reason:
      "suss sends a URL that starts with // to the host written after the //. httpx appends its path to the base and drops the host, aiohttp raises because the URL has no port, and axios on Node throws Invalid URL. Each is a library quirk on an input nobody writes on purpose.",
  },
  {
    libraries: ["faraday", "net-http"],
    pathKinds: ["fullUrlParent"],
    reason:
      "suss reads every absolute URL through new URL, which removes dot segments, and Ruby's URI keeps them. The fix belongs in the shared URL reader in @suss/values, which would have to know the language.",
  },
];

export function gapOf(c: UrlCase): KnownGap | null {
  return (
    KNOWN_GAPS.find(
      (gap) =>
        gap.libraries.includes(c.library) &&
        (gap.baseKinds?.includes(c.baseKind) ?? true) &&
        (gap.pathKinds?.includes(c.pathKind) ?? true),
    ) ?? null
  );
}
