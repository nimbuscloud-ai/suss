/**
 * Looks up a `$ref` in an OpenAPI document and in the files it refers to.
 *
 * A ref reaching this module has one of two forms. `#/components/schemas/Pet`
 * points into the root document. `paths/pets.yaml#/get` starts with the path
 * of another file, from the root document's directory, then points into it. The
 * loader rewrites every ref into one of these forms as it reads each file,
 * because a ref in a split document is written relative to its own file.
 * After that, a lookup never needs to know which file a ref came from.
 *
 * A ref that points at nothing is recorded in `unresolved`, so the caller
 * can say which parts of the document were left out.
 */

import type { Reference } from "./spec.js";

export interface RefScope {
  root: unknown;
  /** The other files the root refers to, keyed by path from the root's directory. */
  documents: ReadonlyMap<string, unknown>;
  unresolved: Set<string>;
}

export function isReference(value: unknown): value is Reference {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { $ref?: unknown }).$ref === "string"
  );
}

/**
 * More refs than this followed for one lookup means a loop, since no
 * document nests that deep on purpose.
 */
const MOST_HOPS = 64;

/**
 * The value a ref points at, or undefined when nothing is there.
 *
 * When the pointer finds nothing in the file the ref gives, it is tried
 * against the root document. Documents split by hand often write
 * `#/components/parameters/Id` inside a path file and mean the root's
 * parameter, and the file itself has no `components` to find it in.
 */
export function lookupRef(scope: RefScope, ref: string): unknown {
  return lookupWithin(scope, ref, { hops: 0 });
}

function lookupWithin(
  scope: RefScope,
  ref: string,
  budget: { hops: number },
): unknown {
  budget.hops += 1;
  if (budget.hops > MOST_HOPS) {
    return undefined;
  }
  const hash = ref.indexOf("#");
  const file = hash === -1 ? ref : ref.slice(0, hash);
  const pointer = hash === -1 ? "" : ref.slice(hash + 1);
  const document = file === "" ? scope.root : scope.documents.get(file);
  if (document === undefined || pointer === "") {
    return document;
  }
  const found = atPointer(scope, document, pointer, budget);
  if (found !== undefined || file === "") {
    return found;
  }
  return atPointer(scope, scope.root, pointer, budget);
}

/**
 * A ref met partway along the pointer is followed before the walk goes
 * on, because some documents write a whole map as one ref, such as
 * `components.parameters` pointing at an index file.
 */
function atPointer(
  scope: RefScope,
  document: unknown,
  pointer: string,
  budget: { hops: number },
): unknown {
  if (!pointer.startsWith("/")) {
    return undefined;
  }
  let current = document;
  for (const segment of pointer.slice(1).split("/")) {
    while (isReference(current)) {
      current = lookupWithin(scope, current.$ref, budget);
    }
    const key = pointerKey(segment);
    if (
      typeof current !== "object" ||
      current === null ||
      !Object.hasOwn(current, key)
    ) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/**
 * Follows a chain of refs to the object at its end. Keys written beside a
 * `$ref` are dropped, as OpenAPI 3.0 says. Undefined means the chain ends
 * at nothing or loops, and the ref is recorded as unresolved.
 */
export function dereferenced<T extends object>(
  value: T | Reference | undefined,
  scope: RefScope,
): T | undefined {
  const followed = new Set<string>();
  let current: unknown = value;
  while (isReference(current)) {
    const ref = current.$ref;
    const target = followed.has(ref) ? undefined : lookupRef(scope, ref);
    if (typeof target !== "object" || target === null) {
      scope.unresolved.add(ref);
      return undefined;
    }
    followed.add(ref);
    current = target;
  }
  if (typeof current !== "object" || current === null) {
    return undefined;
  }
  return current as T;
}

/**
 * A pointer in a URI fragment is percent-encoded first, and then `~1`
 * means `/` and `~0` means `~` (RFC 6901), so the decoding runs in that
 * order.
 */
function pointerKey(segment: string): string {
  return uriDecoded(segment).replaceAll("~1", "/").replaceAll("~0", "~");
}

export function uriDecoded(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    // A stray `%` that starts no escape is kept as written.
    return text;
  }
}
