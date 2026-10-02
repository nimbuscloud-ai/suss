/**
 * What tells two responses with the same status apart by their bodies.
 *
 * A client can only tell two 200s apart by something in the body: a
 * literal one of them writes, such as `{ status: "deleted" }`, or a field
 * one has and the other lacks. Both readings count only what suss read.
 * A body it could not read is never treated as one without the field,
 * because the field may well be there.
 */

import type { Transition, TypeShape } from "@suss/behavioral-ir";

export interface DistinguishingLiteral {
  /** Property path from the body root, e.g. ["status"] or ["user", "role"] */
  path: string[];
  value: string | number | boolean;
}

export interface DistinguishingField {
  /** Property path from the body root, e.g. ["deletedAt"] */
  path: string[];
  /** True when this transition has the field and a sibling does not. */
  present: boolean;
}

/** Every literal-valued field in a shape, with its path. */
function collectBodyLiterals(
  shape: TypeShape,
  pathPrefix: string[] = [],
): DistinguishingLiteral[] {
  if (shape.type === "literal") {
    return [{ path: pathPrefix, value: shape.value }];
  }
  if (shape.type === "record") {
    const results: DistinguishingLiteral[] = [];
    for (const [key, value] of Object.entries(shape.properties)) {
      results.push(...collectBodyLiterals(value, [...pathPrefix, key]));
    }
    return results;
  }
  return [];
}

/**
 * What a sibling's body has at `path`: the shape there, "absent" when a
 * record with no spreads lacks it, or null when the body was not read
 * that far.
 */
function readAtPath(
  sibling: Transition,
  path: string[],
): TypeShape | "absent" | null {
  if (sibling.output.type !== "response" || sibling.output.body === null) {
    return null;
  }
  let current: TypeShape = sibling.output.body;
  for (const segment of path) {
    if (current.type !== "record") {
      return null;
    }
    const next = current.properties[segment];
    if (next === undefined) {
      return (current.spreads?.length ?? 0) > 0 ? null : "absent";
    }
    current = next;
  }
  return current;
}

/**
 * The literal body fields that tell `transition` apart from its
 * siblings with the same status: some sibling has a different literal
 * at the same path, or provably does not have the path at all.
 */
export function findDistinguishingLiterals(
  transition: Transition,
  siblings: readonly Transition[],
): DistinguishingLiteral[] {
  if (
    transition.output.type !== "response" ||
    transition.output.body === null
  ) {
    return [];
  }

  return collectBodyLiterals(transition.output.body).filter((lit) =>
    siblings.some((sibling) => {
      if (sibling.id === transition.id) {
        return false;
      }
      const siblingValue = readAtPath(sibling, lit.path);
      if (siblingValue === "absent") {
        return true;
      }
      return (
        siblingValue?.type === "literal" && siblingValue.value !== lit.value
      );
    }),
  );
}

/**
 * The top-level fields this transition has that at least one sibling
 * with the same status provably lacks. Nested records are not walked,
 * since top-level presence is the usual discriminator.
 */
export function findDistinguishingFields(
  transition: Transition,
  siblings: readonly Transition[],
): DistinguishingField[] {
  if (
    transition.output.type !== "response" ||
    transition.output.body === null ||
    transition.output.body.type !== "record"
  ) {
    return [];
  }

  return Object.keys(transition.output.body.properties)
    .map((key) => [key])
    .filter((fieldPath) =>
      siblings.some(
        (sibling) =>
          sibling.id !== transition.id &&
          readAtPath(sibling, fieldPath) === "absent",
      ),
    )
    .map((path) => ({ path, present: true }));
}

/** A body suss read the structure of, as opposed to none, an opaque type name, or unknown. */
function bodyWasRead(transition: Transition): boolean {
  if (transition.output.type !== "response") {
    return false;
  }
  const body = transition.output.body;
  return body !== null && body.type !== "unknown" && body.type !== "ref";
}

/**
 * Whether a client could tell these same-status responses apart by
 * their bodies: suss read every one of them, and some literal or field
 * differs between them.
 */
export function bodiesTellApart(transitions: readonly Transition[]): boolean {
  if (!transitions.every(bodyWasRead)) {
    return false;
  }
  return transitions.some(
    (transition) =>
      findDistinguishingLiterals(transition, transitions).length > 0 ||
      findDistinguishingFields(transition, transitions).length > 0,
  );
}
