// boundaryKey.ts — derive a stable grouping key from a BoundaryBinding.
//
// A shared primitive: the behavioural checker pairs code summaries by
// this key, and the intent checker pairs intent against code by the same
// key. They MUST agree on keying or intent and code never line up, so it
// lives here next to the binding rather than in either checker.

import type { BoundaryBinding } from "./index.js";

/**
 * Normalize a route path to a canonical form for matching.
 *
 * - Converts Express-style params (`:id`) to brace-style (`{id}`)
 * - Strips trailing slashes (except bare `/`)
 * - Lowercases the static segments (params stay case-sensitive)
 */
export function normalizePath(path: string): string {
  // :param → {param}
  let normalized = path.replace(/:([a-zA-Z_]\w*)/g, "{$1}");

  // Strip trailing slash (keep bare /)
  if (normalized.length > 1 && normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1);
  }

  // Lowercase static segments, preserve param names inside braces
  normalized = normalized.replace(/\{[^}]+\}|[^{]+/g, (segment) =>
    segment.startsWith("{") ? segment : segment.toLowerCase(),
  );

  return normalized;
}

/**
 * Compute a stable string key from a boundary binding for grouping.
 * Dispatches on `semantics.name`:
 *   - `rest` → `"METHOD /normalized/path"` (null if method or path empty)
 *   - `graphql-resolver` → `"gql:<TypeName>.<fieldName>"`
 *   - `function-call` → `"fn:<package>::<exportPath>"` when both
 *     `package` and `exportPath` are set; other in-process function-call
 *     units (intra-repo components, bare handlers) return null.
 *   - everything else → null
 */
export function boundaryKey(binding: BoundaryBinding): string | null {
  const semantics = binding.semantics;
  if (semantics.name === "rest") {
    if (semantics.method === "" || semantics.path === "") {
      return null;
    }
    const method = semantics.method.toUpperCase();
    const path = normalizePath(semantics.path);
    return `${method} ${path}`;
  }
  if (semantics.name === "graphql-resolver") {
    return `gql:${semantics.typeName}.${semantics.fieldName}`;
  }
  if (semantics.name === "function-call") {
    if (
      semantics.package !== undefined &&
      semantics.exportPath !== undefined &&
      semantics.exportPath.length > 0
    ) {
      return `fn:${semantics.package}::${semantics.exportPath.join(".")}`;
    }
    return null;
  }
  return null;
}
