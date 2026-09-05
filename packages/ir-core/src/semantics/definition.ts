/**
 * The contract a boundary protocol implements.
 *
 * A protocol (REST, message-bus, one side of GraphQL) is a single
 * module in this directory. Its schema says what the identity fields
 * are, its behavior says how those fields key and agree, and the two
 * travel together so neither can be added without the other. Nothing
 * outside a protocol's own module decides how its boundaries behave.
 *
 * These definitions ship with ir-core rather than with the packs,
 * because a published summary has to mean the same thing to a reader
 * who never installed the pack that wrote it. If a pack needs a
 * protocol nobody has defined yet, add a module here.
 *
 * A protocol also says which of its words come from OpenTelemetry's
 * semantic conventions, in `semconv`. The README says why that
 * matters and where it stops.
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
   * Values suss writes where the source named none. A span never says
   * them, so the projection leaves the attribute off rather than
   * emitting a string that could only ever mismatch.
   */
  placeholderValues?: readonly string[];
}

/**
 * Which identity fields the semantic conventions have an attribute
 * for. A field is absent when they have no attribute for it, or when
 * our value is our own string rather than the one a span gets.
 */
export type SemconvMapping<S extends { name: string }> = {
  readonly [K in Exclude<keyof S, "name">]?: SemconvAttribute;
};

/**
 * How one semantics variant keys its boundaries and pairs them up. Each
 * variant fills this in inside its own module, and nothing else in the
 * tree gets a say in how a boundary keys or agrees.
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
   * Settles whatever `pairingKey` left out of the bucket. A variant that
   * does not define it always agrees.
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
   * lexicographically. When a consumer meets more than one bucket, the
   * one ranking highest is the one it reaches, and an even contest is
   * reported rather than paired.
   */
  bucketRank?(semantics: S): readonly number[];

  /** The line a reader sees for this boundary. Defaults to `identityKey`. */
  displayLabel?(semantics: S): string | null;

  /**
   * The semantics with any filesystem path it states rewritten, for
   * the pass that makes a summary's paths project-relative. A
   * protocol that states no path declares nothing here.
   */
  rewritePaths?(semantics: S, rewrite: (path: string) => string): S;

  /**
   * The first protocol whose `claims` returns true normalizes a
   * hand-written suppression boundary, and a string nobody claims is
   * compared byte for byte. A protocol whose keys are exact declares
   * nothing here and stays verbatim.
   */
  ruleBoundary?: {
    claims(raw: string): boolean;
    normalize(raw: string): string;
  };

  /**
   * A protocol whose boundaries have no URL leaves this undefined, which
   * is different from an "unknown" result: undefined means the question
   * does not apply, and unknown means this declaration cannot settle it.
   */
  servesRequest?(semantics: S, method: string, path: string): MatchResult;

  /**
   * Whether every request this boundary takes falls inside a pattern
   * something else was registered for. Middleware registered for
   * `/v1/*` runs for `/v1/tenants/{id}` and not for `/health`, so
   * composing it into a unit asks this first.
   *
   * A protocol whose boundaries no pattern addresses leaves this
   * undefined, and nothing registered with a pattern reaches them.
   */
  withinScope?(semantics: S, scope: string): boolean;

  /**
   * The same boundary with a name the deployment fills in put in.
   *
   * A call written as `fetch(`${process.env.API_BASE}/orders`)` gets
   * part of its boundary from the source and part from whatever runs
   * the code. Both parts have to be in before anybody can see that the
   * two sides describe one boundary.
   *
   * `deployment` is already scoped to the unit this boundary belongs
   * to. A protocol hands over the reference its name states and gets
   * back what fills it in, or null. Return null to leave it as it is,
   * which is right whenever nothing needs filling in or nothing can
   * fill it.
   *
   * A protocol whose names are settled in the source leaves this
   * undefined.
   */
  groundName?(semantics: S, deployment: Deployment): S | null;

  /**
   * Where this boundary's name says to go and ask, when it says that
   * rather than a name. A caller that has to explain why two sides did
   * not meet reads it to say which input would settle them.
   *
   * A protocol that defines `groundName` defines this too, and the
   * same reference is what `groundName` hands over.
   */
  nameReference?(semantics: S): Reference | null;

  /**
   * Whether a provider produces a status and a body that a consumer
   * reads back. Every protocol has to state this, so that one added
   * later says what it is instead of landing in the HTTP-style checks
   * because nobody remembered to exclude it.
   */
  exchangesHttpResponses: boolean;

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
   * Every protocol declares this, empty included, so that adding one
   * means deciding where its words come from.
   */
  semconv: SemconvMapping<z.infer<Z>>;
}

/** Keeps the schema's precise type, so the registry's union does not widen. */
export function defineBoundarySemantics<Z extends z.ZodType<{ name: string }>>(
  definition: BoundarySemanticsDefinition<Z>,
): BoundarySemanticsDefinition<Z> {
  return definition;
}
