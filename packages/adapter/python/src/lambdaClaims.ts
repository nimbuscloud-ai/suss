/**
 * Which lambdas a run's packs claim as units of their own, as the readers
 * that list a body's calls ask it. A claimed lambda's calls go on its own
 * summary, so a reader of the function it is written in leaves them out.
 *
 * A run registers claims only when some pack has a `subUnits` hook. In
 * any other run the lookup comes back empty, so a reader never runs a
 * hook or asks a question.
 */

import { enclosingFunction, isFunction } from "./ast.js";

import type { Database } from "@suss/datalog";
import type { PyNode } from "./parser.js";

/** A lambda a pack claims, with the name its unit gets. */
export interface NamedClaim {
  readonly lambda: PyNode;
  readonly name: string;
}

/** What a reader asks. */
export interface LambdaClaims {
  /** The node ids of the lambdas claimed in one function. */
  claimedIn(fn: PyNode): ReadonlySet<number>;
  /** The lambdas claimed in one function, each named after `name`, the function's own. */
  claimsNamedAfter(fn: PyNode, name: string): NamedClaim[];
}

const claimsByRun = new WeakMap<Database, LambdaClaims>();

const NONE: ReadonlySet<number> = new Set();

/** Makes these the claims every reader over `db` asks. */
export function registerLambdaClaims(db: Database, claims: LambdaClaims): void {
  claimsByRun.set(db, claims);
}

/** The lambdas claimed in the function `node` is, or in the one whose body `node` is. */
export function claimedLambdas(
  node: PyNode,
  facts: Database | undefined,
): ReadonlySet<number> {
  const claims = facts === undefined ? undefined : claimsByRun.get(facts);
  if (claims === undefined) {
    return NONE;
  }
  const fn = isFunction(node) ? node : enclosingFunction(node);
  return fn === null ? NONE : claims.claimedIn(fn);
}

/** The lambdas claimed in `fn`, each with the name its unit gets when `fn` is called `name`. */
export function claimsNamedAfter(
  fn: PyNode,
  name: string,
  facts: Database | undefined,
): NamedClaim[] {
  const claims = facts === undefined ? undefined : claimsByRun.get(facts);
  return claims === undefined ? [] : claims.claimsNamedAfter(fn, name);
}
