/**
 * The interface a boundary protocol implements.
 *
 * Each protocol (REST, message-bus, one side of GraphQL) is one module
 * in this directory. Its schema lists the identity fields, and its
 * behavior defines how those fields key and agree. The two are defined
 * together, so neither can be added without the other.
 *
 * The definitions ship with ir-core and not with the packs, because a
 * published summary has to mean the same thing to a reader who never
 * installed the pack that wrote it. A pack that needs a new protocol
 * adds a module here. Each protocol also maps its fields to
 * OpenTelemetry attributes in `semconv`, as the package README explains.
 */

import type { z } from "zod";
import type { Reference } from "../boundaryName.js";
import type { Deployment } from "../deployment.js";
import type { MatchResult } from "../typeShapeMatch.js";

/** One identity field written as an OpenTelemetry attribute. */
export interface SemconvAttribute {
  /** The attribute name, as the semantic conventions spell it. */
  name: string;
  /**
   * Values suss writes when the source gave none. A span never has
   * them, so the projection leaves the attribute out instead of writing
   * a value that could never match.
   */
  placeholderValues?: readonly string[];
}

/**
 * Which identity fields the semantic conventions have an attribute
 * for. A field is absent when the conventions have no attribute for it,
 * or when suss writes its own value there instead of the one a span gets.
 */
export type SemconvMapping<S extends { name: string }> = {
  readonly [K in Exclude<keyof S, "name">]?: SemconvAttribute;
};

/**
 * How one protocol keys its boundaries and pairs them up. Each protocol
 * implements this in its own module, and every rule for how its
 * boundaries key or agree is defined there.
 */
export interface BoundaryBehavior<S extends { name: string }> {
  /** Null when the source never gave the boundary a name. */
  identityKey(semantics: S): string | null;

  /**
   * The bucket the pairing pass groups by. Defaults to `identityKey`.
   * Define it where one side can know more than its counterpart, and put
   * only the shared part in the bucket: a `"*"` REST route has to meet
   * consumers that each specify one method, so REST buckets by path
   * alone. Whatever the bucket leaves out, `sidesAgree` has to compare.
   */
  pairingKey?(semantics: S): string | null;

  /**
   * Compares the fields `pairingKey` left out of the bucket. When a
   * protocol does not define it, every pair in a bucket agrees.
   */
  sidesAgree?(a: S, b: S): boolean;

  /**
   * Whether this boundary's bucket can meet buckets with other keys. A
   * REST path with a hole that spans some number of segments has a key
   * of its own and serves what several other keys serve, so the pairing
   * pass compares it against every bucket on the other side with
   * `bucketsMeet`. A variant that does not define it meets only its own
   * key.
   */
  spansBuckets?(semantics: S): boolean;

  /** Whether two buckets describe at least one boundary in common. */
  bucketsMeet?(a: S, b: S): boolean;

  /**
   * How narrowly this bucket states what it serves, compared
   * lexicographically. When a consumer meets more than one bucket, it
   * reaches the one ranked highest, and a tie is reported instead of
   * paired.
   */
  bucketRank?(semantics: S): readonly number[];

  /** The label a reader sees for this boundary. Defaults to `identityKey`. */
  displayLabel?(semantics: S): string | null;

  /**
   * The semantics with every filesystem path in it rewritten, for the
   * pass that makes a summary's paths project-relative. A protocol
   * without paths leaves this undefined.
   */
  rewritePaths?(semantics: S, rewrite: (path: string) => string): S;

  /**
   * How a hand-written suppression boundary is normalized. The first
   * protocol whose `claims` returns true normalizes the string, and a
   * string no protocol claims is compared byte for byte. A protocol
   * whose keys compare exactly leaves this undefined.
   */
  ruleBoundary?: {
    claims(raw: string): boolean;
    normalize(raw: string): string;
  };

  /**
   * Whether this boundary serves a request with the given method and
   * path. A protocol whose boundaries have no URL leaves this undefined.
   * Undefined means the question does not apply, and an `"unknown"`
   * result means this declaration cannot settle it.
   */
  servesRequest?(semantics: S, method: string, path: string): MatchResult;

  /**
   * Whether every request this boundary takes falls inside a pattern
   * something else was registered for. Middleware registered for
   * `/v1/*` runs for `/v1/tenants/{id}` and not for `/health`, so
   * composing middleware into a unit checks this first.
   *
   * A protocol whose boundaries no pattern addresses leaves this
   * undefined, and nothing registered with a pattern reaches them.
   */
  withinScope?(semantics: S, scope: string): boolean;

  /**
   * The same boundary with the deployment's values filled into its name.
   *
   * A call written as `fetch(`${process.env.API_BASE}/orders`)` gets
   * part of its boundary from the source and part from whatever runs
   * the code. Both parts are needed before the two sides can be matched
   * as one boundary.
   *
   * `deployment` is already scoped to the unit this boundary belongs
   * to. The protocol looks up the reference in its name through it.
   * Return null to leave the semantics unchanged, when nothing needs
   * filling in or nothing can fill it. A protocol whose names are fixed
   * in the source leaves this undefined.
   */
  groundName?(semantics: S, deployment: Deployment): S | null;

  /**
   * The reference in this boundary's name, when the name is a
   * reference. A caller explaining why two sides did not pair uses it
   * to say which input would settle the name.
   *
   * A protocol that defines `groundName` defines this too, and
   * `groundName` looks up the same reference.
   */
  nameReference?(semantics: S): Reference | null;

  /**
   * Whether a provider produces a status and a body that a consumer
   * reads back. It is required, so a new protocol cannot end up in the
   * HTTP-style checks because nobody remembered to exclude it.
   */
  exchangesHttpResponses: boolean;

  /**
   * Whether crossing this boundary leaves the process. A report on what
   * a change means for callers outside the code covers only these. A
   * call between two functions in one project is a boundary too, and a
   * reader has the source diff for it.
   */
  leavesTheProcess: boolean;

  /**
   * Whether this protocol's own pass already reports a boundary that
   * paired with nothing, so the generic unmatched list can leave it out.
   */
  reportsUnpairedItself: boolean;

  /**
   * Whether a boundary with these semantics can pair with anything.
   * Defaults to a non-null pairing key. A protocol whose dedicated
   * pass pairs keyless boundaries overrides it, the way GraphQL
   * operations pair by document rather than by key.
   */
  canPair?(semantics: S): boolean;
}

/**
 * One protocol in full: the schema for its identity fields, and the
 * behavior that keys them. The registry composes these into the
 * `Semantics` union and the runtime lookup.
 */
export interface BoundarySemanticsDefinition<
  Z extends z.ZodType<{ name: string }>,
> {
  name: z.infer<Z>["name"];
  schema: Z;
  behavior: BoundaryBehavior<z.infer<Z>>;
  /**
   * Required even when empty, so adding a protocol means deciding which
   * of its fields are OpenTelemetry attributes.
   */
  semconv: SemconvMapping<z.infer<Z>>;
}

/** Keeps the schema's precise type, so the registry's union does not widen. */
export function defineBoundarySemantics<Z extends z.ZodType<{ name: string }>>(
  definition: BoundarySemanticsDefinition<Z>,
): BoundarySemanticsDefinition<Z> {
  return definition;
}
