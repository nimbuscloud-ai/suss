// definition.ts: the contract a boundary protocol implements.
//
// A protocol (REST, message-bus, a GraphQL side) is one module under
// this directory: its schema says what the identity fields are, its
// behavior says how they key and agree, and the two travel together so
// neither can be added without the other. The registry composes the
// modules; nothing outside a protocol's module decides how its
// boundaries behave.
//
// The definitions ship with ir-core rather than with packs because a
// published summary has to mean the same thing to a reader who never
// installed the pack that wrote it. Packs choose a protocol and fill
// its fields; a pack that needs a protocol nobody defined is the cue
// to add a module here.

import type { z } from "zod";

/**
 * How one semantics variant keys and pairs. Written once, in the
 * variant's own module; nothing else in the tree decides how a
 * boundary keys or agrees.
 */
export interface BoundaryBehavior<S extends { name: string }> {
  /**
   * The name a reader sees and a suppression targets, or null when
   * the source never stated one.
   *
   *   rest         { method: "GET", path: "/Users/:id" }  → "GET /users/{id}"
   *   rest         { method: "*", path: "/api/users" }    → "* /api/users"
   *   message-bus  { messageBus: "sqs", channel: null }   → null
   */
  identityKey(semantics: S): string | null;

  /**
   * The bucket the pairing pass groups by. Defaults to `identityKey`,
   * which is right when the identity is the whole story.
   *
   * Define it when one side's identity can say more than its
   * counterpart is able to know, and give the bucket only the shared
   * part, so the two still land together. A REST identity carries its
   * method, but a `"*"` route has to meet consumers that each name
   * one method, so REST buckets carry the path alone:
   *
   *   { method: "GET", path: "/api/users" }  → "rest /api/users"
   *   { method: "*",  path: "/api/users" }   → "rest /api/users"
   *
   * Whatever the bucket drops, `sidesAgree` must compare, or two
   * boundaries that share a bucket would pair on the shared part
   * alone.
   */
  pairingKey?(semantics: S): string | null;

  /**
   * Whether two sides that share a bucket name the same boundary.
   * Defaults to yes, which is right when the bucket is the whole
   * identity.
   *
   * Define it to settle exactly what `pairingKey` dropped:
   *
   *   rest         GET and "*"                                    agree
   *   rest         GET and POST                                   do not
   *   message-bus  "default#order.placed" and "order.placed"      agree
   *   message-bus  "default#o.p" and "staging#o.p"                do not
   *
   * The asymmetric cases are the point: a wildcard route answers the
   * method a consumer names, and a side that cannot know its bus is
   * not penalized for the bus a counterpart does know.
   */
  sidesAgree?(a: S, b: S): boolean;
}

/**
 * One protocol, whole: the schema for its identity fields and the
 * behavior that keys them. The registry composes these into the
 * `Semantics` union and the runtime lookup.
 */
export interface BoundarySemanticsDefinition<
  Z extends z.ZodType<{ name: string }>,
> {
  name: z.infer<Z>["name"];
  schema: Z;
  behavior: BoundaryBehavior<z.infer<Z>>;
}

/**
 * Identity helper that keeps the schema's precise type on the
 * definition, so the registry can build the discriminated union from
 * `definition.schema` without widening.
 */
export function defineBoundarySemantics<Z extends z.ZodType<{ name: string }>>(
  definition: BoundarySemanticsDefinition<Z>,
): BoundarySemanticsDefinition<Z> {
  return definition;
}
