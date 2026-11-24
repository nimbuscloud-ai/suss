/**
 * One request per arm, for a call whose URL or method a branch before it
 * picks, as `endpoint = id ? {PATCH, /x/1} : {POST, /x}` does before
 * `fetch(endpoint.url, { method: endpoint.method })`. The value engine
 * joins the two arms, so the call is read again with each arm taken,
 * through the ops' `takingArms`, and each request the arms give becomes
 * a claim with the arms it was read under.
 *
 * A fork is split only when its arms give different requests, and one
 * inside an arm only once that arm is taken. When two different
 * conditions both change the request, their combinations may not all
 * run, so the call keeps its plain reading. Nothing caps the count.
 */

import type { CallFork, CallOps, ForkArm, RequestClaim } from "@suss/extractor";

/** A request the call makes, and how sure suss is of its method. */
export interface Reading {
  readonly claim: RequestClaim;
  /** Whether the call states a method as a value that does not come to one string. */
  readonly methodOpen: boolean;
  /**
   * Whether the method is the library's default only because suss could
   * not read the method the call states, or the options it passes.
   */
  readonly methodGuessed: boolean;
}

/** Reads the request the call makes with the values its ops give. */
type ReadUnder = (ops: CallOps) => Reading | null;

/** A request that a set of arms gives, and those arms by key. */
interface Leaf {
  readonly reading: Reading;
  readonly arms: ReadonlyMap<string, ForkArm>;
}

/** The split could not tell which requests run, so the call keeps its plain reading. */
const GIVE_UP = null;

// A set piece, `(a|b)`, is what a join of two arms that differ in one
// piece of the URL writes.
const SET_PIECE = /\([^()]*\|[^()]*\)/;

/**
 * Whether the plain reading misses something an arm could settle: no
 * request at all, no method, a stated method that did not settle, no
 * path, or a path with a set of texts in it.
 */
export function lacking(reading: Reading | null): boolean {
  if (reading === null) {
    return true;
  }
  const { claim } = reading;
  return (
    claim.method === null ||
    reading.methodOpen ||
    claim.path === null ||
    SET_PIECE.test(claim.path)
  );
}

/**
 * One claim per request the arms of a branch before the call give, or
 * null when the call keeps its plain reading: the ops cannot take arms,
 * no fork changes the request, no arm reads a path, or the split gave
 * up.
 */
export function alternativeClaims(
  ops: CallOps,
  plain: Reading | null,
  readUnder: ReadUnder,
): RequestClaim[] | null {
  if (ops.forks === undefined || ops.takingArms === undefined) {
    return null;
  }
  // A URL the class's constructor gives is read per construction instead.
  if ((ops.constructionSites?.() ?? []).length > 0) {
    return null;
  }
  const leaves = splitAt(ops, readUnder, new Map(), new Map(), null);
  if (leaves === GIVE_UP) {
    return null;
  }
  const requests = merged(leaves);
  // Requests none of which pairs would only add unread clients.
  const anyPath = requests.some((claim) => claim.path !== null);
  if (!anyPath || (requests.length === 1 && plain !== null)) {
    return null;
  }
  return requests;
}

function splitAt(
  ops: CallOps,
  readUnder: ReadUnder,
  picked: ReadonlyMap<string, number>,
  chosen: ReadonlyMap<string, ForkArm>,
  last: string | null,
): Leaf[] | null {
  const at = picked.size === 0 ? ops : takingArms(ops, picked);
  const met = at.forks?.() ?? null;
  if (met === null || met.exhausted) {
    return GIVE_UP;
  }
  if (!met.reached) {
    return picked.size === 0 ? GIVE_UP : [];
  }
  const differing: CallFork[] = [];
  for (const fork of met.forks) {
    if (!changesRequest(ops, readUnder, picked, fork)) {
      continue;
    }
    // A fork beside the last one taken, rather than inside its arm,
    // would combine with it in ways that may not run.
    if (fork.under !== last) {
      return GIVE_UP;
    }
    differing.push(fork);
  }
  const [only, ...others] = differing;
  if (only === undefined) {
    const reading = readUnder(at);
    // A default method in place of one suss could not read would pair
    // each arm's URL with a route the code may never call.
    if (reading?.methodGuessed === true) {
      return GIVE_UP;
    }
    return reading === null ? [] : [{ reading, arms: chosen }];
  }
  if (others.length > 0) {
    return GIVE_UP;
  }
  const leaves: Leaf[] = [];
  for (let arm = 0; arm < only.arms; arm++) {
    const below = splitAt(
      ops,
      readUnder,
      new Map([...picked, [only.key, arm]]),
      new Map([...chosen, [only.key, { at: only.at, arm: ownArm(only, arm) }]]),
      only.key,
    );
    if (below === GIVE_UP) {
      return GIVE_UP;
    }
    leaves.push(...below);
  }
  return leaves;
}

/** Whether the fork's arms give different requests. */
function changesRequest(
  ops: CallOps,
  readUnder: ReadUnder,
  picked: ReadonlyMap<string, number>,
  fork: CallFork,
): boolean {
  const requests = new Set<string>();
  for (let arm = 0; arm < fork.arms; arm++) {
    const reading = readUnder(
      takingArms(ops, new Map([...picked, [fork.key, arm]])),
    );
    requests.add(reading === null ? "" : boundaryOf(reading.claim));
  }
  return requests.size > 1;
}

function takingArms(ops: CallOps, arms: ReadonlyMap<string, number>): CallOps {
  return ops.takingArms?.(arms) ?? ops;
}

/** The fork's own arm for an arm of its key. */
function ownArm(fork: CallFork, keyArm: number): number {
  return fork.negated && fork.arms === 2 ? 1 - keyArm : keyArm;
}

function boundaryOf(claim: RequestClaim): string {
  return `${claim.method} ${claim.host ?? ""} ${claim.path}`;
}

/**
 * One claim per request, in the order the arms give them. Two arms that
 * give the same request share it, under the arms they both took.
 */
function merged(leaves: readonly Leaf[]): RequestClaim[] {
  const byRequest = new Map<string, Leaf>();
  for (const leaf of leaves) {
    const key = boundaryOf(leaf.reading.claim);
    const seen = byRequest.get(key);
    byRequest.set(
      key,
      seen === undefined
        ? leaf
        : { reading: seen.reading, arms: sharedArms(seen.arms, leaf.arms) },
    );
  }
  return [...byRequest.values()].map(claimOf);
}

function sharedArms(
  a: ReadonlyMap<string, ForkArm>,
  b: ReadonlyMap<string, ForkArm>,
): ReadonlyMap<string, ForkArm> {
  return new Map(
    [...a].filter(([key, arm]) => {
      const other = b.get(key);
      return (
        other !== undefined && other.at === arm.at && other.arm === arm.arm
      );
    }),
  );
}

/**
 * The claim for one request. A method an arm settles is the method, so
 * the claim drops the value it was stated as, and the adapter does not
 * point the method at a parameter another arm reads.
 */
function claimOf({ reading, arms }: Leaf): RequestClaim {
  const { claim } = reading;
  const stated = claim.read.stated;
  const read =
    reading.methodOpen || stated?.method === undefined
      ? claim.read
      : {
          ...claim.read,
          stated: {
            ...(stated.host === undefined ? {} : { host: stated.host }),
          },
        };
  return { ...claim, read, arms: [...arms.values()] };
}
