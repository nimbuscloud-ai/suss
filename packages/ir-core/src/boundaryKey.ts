// boundaryKey.ts — derive a stable grouping key from a BoundaryBinding.
//
// A shared primitive: the behavioural checker pairs code summaries by
// this key, and the intent checker pairs intent against code by the same
// key. They MUST agree on keying or intent and code never line up, so it
// lives here next to the binding rather than in either checker.

import { parseChannel } from "./channel.js";

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
 *   - `message-bus` → `"bus:<messageBus> <subject>"` (null if the
 *     subject is empty)
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
  if (semantics.name === "message-bus") {
    // The key carries the subject and drops the bus, so a template that
    // writes `default#order.placed` and a handler that writes
    // `order.placed` land in one bucket. Whether the buses agree is a
    // question for `channelsPair`, which the pairing pass asks inside
    // the bucket; a side that cannot know its bus would otherwise be
    // keyed away from the side that can.
    //
    // The bus technology stays in the key the way the HTTP method stays
    // in a REST key. A queue and an event router are different
    // destinations even when they carry the same subject name.
    //
    // Subjects keep their case. Detail-types and queue logical ids are
    // compared byte for byte by AWS, so folding case here would pair
    // two channels that never reach each other.
    const { subject } = parseChannel(semantics.channel);
    if (subject === "") {
      return null;
    }
    return `bus:${semantics.messageBus} ${subject}`;
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
