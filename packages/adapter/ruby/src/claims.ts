/**
 * The blocks and lambdas a declared pack claims as units of their own,
 * such as the block in `jobs.later { notify }`, kept for one run.
 *
 * A unit reads its method's body during discovery, before anything knows
 * the method has a block a pack claims. So the run keeps one registry,
 * keyed by its facts database, and the first reader to ask about a method
 * runs every pack's `subUnits` hook over it. From then on every reader of
 * that method's body skips the claimed nodes, so what a claimed block does
 * goes on its own summary and not on the method's as well. Only a method
 * claims, so a block claimed inside another claimed block belongs to the
 * method too. A run with no pack that claims sub-units has no registry.
 */

import { runPackHook } from "@suss/extractor";

import {
  children,
  enclosingDefinition,
  field,
  METHOD_TYPES,
  OWN_BODY_TYPES,
  statementsOf,
} from "./ast.js";
import { nodeId } from "./facts/values.js";
import { localNamesIn } from "./paths/bareCalls.js";
import { boundFileOf } from "./values/evaluator.js";

import type { Database } from "@suss/datalog";
import type {
  DiscoveredSubUnit,
  DiscoveredSubUnitParent,
  PackTally,
  SubUnitOpsCarrier,
} from "@suss/extractor";
import type { RubyPack } from "./pack.js";
import type { RbNode } from "./parser.js";
import type { ReadableBody } from "./paths/effects.js";

/** A pack's `subUnits` hook, beside the pack's name. */
export interface ClaimingPack {
  readonly name: string;
  readonly subUnits: NonNullable<RubyPack["subUnits"]>;
}

/** What the packs claim in one method. */
export interface MethodClaims {
  readonly method: RbNode;
  /** The absolute path the facts key the method on. */
  readonly file: string;
  /** The method's own fact key, the one its reach seed has. */
  readonly key: string;
  /** The claimed blocks and lambdas, in the order the hooks gave them. */
  readonly nodes: readonly RbNode[];
  /** The same nodes by id, for a reader of the method's body to skip. */
  readonly ids: ReadonlySet<number>;
  /** The method's locals, which a claimed block reads as its own. */
  readonly locals: ReadonlySet<string>;
}

/** A block written with `{ }` or `do ... end`, or a `->` lambda. */
const CLAIMABLE_TYPES = new Set(["block", "do_block", "lambda"]);

const NOTHING_CLAIMED: ReadonlySet<number> = new Set<number>();

/** The kind a method is handed to the hooks as while its body is read, before any summary of it says what it is. */
const KIND_WHILE_READING = "library";

export class SubUnitRegistry {
  private readonly byMethod = new Map<string, MethodClaims>();
  private readonly byClaim = new Map<string, MethodClaims>();

  constructor(
    private readonly packs: readonly ClaimingPack[],
    private readonly context: SubUnitOpsCarrier,
    private readonly tallies: ReadonlyMap<string, PackTally>,
  ) {}

  /**
   * The sub-units the packs build for this parent, a method in `file`.
   * When two packs claim the same node, the first pack in the run's list
   * keeps it. A hook that throws claims nothing, and the failure goes on
   * its pack's tally.
   */
  subUnitsOf(
    parent: DiscoveredSubUnitParent,
    file: string,
  ): DiscoveredSubUnit[] {
    const seen = new Set<number>();
    return this.packs
      .flatMap((pack) =>
        runPackHook(
          this.tallies.get(pack.name),
          { pack: pack.name, hook: "subUnits", file },
          () => pack.subUnits(parent, this.context),
          [],
        ),
      )
      .filter((one) => {
        const id = (one.func as RbNode).id;
        if (seen.has(id)) {
          return false;
        }
        seen.add(id);
        return true;
      });
  }

  /** What the packs claim in this method. The hooks run once for each method. */
  claimsOf(method: RbNode): MethodClaims | null {
    const file = boundFileOf(method);
    if (file === undefined) {
      return null;
    }
    const key = nodeId(file, method);
    const known = this.byMethod.get(key);
    if (known !== undefined) {
      return known;
    }
    // Until the hooks return, the method claims nothing, so a read of its
    // body they make on the way does not run them again.
    const none: MethodClaims = {
      method,
      file,
      key,
      nodes: [],
      ids: NOTHING_CLAIMED,
      locals: new Set<string>(),
    };
    this.byMethod.set(key, none);
    const nodes = this.subUnitsOf(
      {
        func: method,
        name: field(method, "name")?.text ?? "",
        kind: KIND_WHILE_READING,
      },
      file,
    ).map((one) => one.func as RbNode);
    if (nodes.length === 0) {
      return none;
    }
    const claims: MethodClaims = {
      ...none,
      nodes,
      ids: new Set(nodes.map((node) => node.id)),
      locals: localNamesIn(method),
    };
    this.byMethod.set(key, claims);
    for (const node of nodes) {
      this.byClaim.set(nodeId(file, node), claims);
    }
    return claims;
  }

  /** The claims of the method this node is, or is written in. */
  claimsAround(node: RbNode): MethodClaims | null {
    const method = owningMethod(node);
    return method === null ? null : this.claimsOf(method);
  }

  /**
   * The claims of the method that claimed this block or lambda, or null
   * when no pack claimed it. The method is asked about first, so the
   * answer does not depend on which of the two a reader reached first.
   */
  claimerOf(node: RbNode): MethodClaims | null {
    if (!CLAIMABLE_TYPES.has(node.type)) {
      return null;
    }
    const around = this.claimsAround(node);
    return around === null
      ? null
      : (this.byClaim.get(nodeId(around.file, node)) ?? null);
  }

  /** The claims of a method some reader already asked about, by its fact key. */
  claimsByKey(key: string): MethodClaims | undefined {
    const claims = this.byMethod.get(key);
    return claims === undefined || claims.nodes.length === 0
      ? undefined
      : claims;
  }

  /** The blocks and lambdas this method claims, each named after `name`, the method's own. */
  claimsNamedAfter(method: RbNode, name: string): NamedClaim[] {
    const claims = this.claimsOf(method);
    if (claims === null || claims.nodes.length === 0) {
      return [];
    }
    return this.subUnitsOf(
      { func: method, name, kind: KIND_WHILE_READING },
      claims.file,
    )
      .filter((one) => claims.ids.has((one.func as RbNode).id))
      .map((one) => ({ node: one.func as RbNode, name: one.name }));
  }
}

/** A block or lambda a pack claims, with the name its unit gets. */
export interface NamedClaim {
  readonly node: RbNode;
  readonly name: string;
}

/** The method a node is, or the one it is written in, through any lambdas around it. */
function owningMethod(node: RbNode): RbNode | null {
  if (METHOD_TYPES.has(node.type)) {
    return node;
  }
  const around = enclosingDefinition(node);
  return around === null ? null : owningMethod(around);
}

const registries = new WeakMap<Database, SubUnitRegistry>();

/** Starts the run's registry over `db`, for the packs that claim sub-units. A hook that throws goes on its pack's tally in `tallies`. */
export function registerSubUnits(
  db: Database,
  claiming: readonly ClaimingPack[],
  context: SubUnitOpsCarrier,
  tallies: ReadonlyMap<string, PackTally>,
): SubUnitRegistry {
  const registry = new SubUnitRegistry(claiming, context, tallies);
  registries.set(db, registry);
  return registry;
}

/** The packs in the run that claim sub-units, each with its hook. */
export function claimingPacksIn(packs: readonly RubyPack[]): ClaimingPack[] {
  return packs.flatMap((pack) =>
    pack.subUnits === undefined
      ? []
      : [{ name: pack.name, subUnits: pack.subUnits }],
  );
}

/** Whether some pack in the run claims sub-units. */
export function claimsSubUnits(packs: readonly RubyPack[]): boolean {
  return packs.some((pack) => pack.subUnits !== undefined);
}

function registryOf(facts: Database | undefined): SubUnitRegistry | undefined {
  return facts === undefined ? undefined : registries.get(facts);
}

/**
 * The ids of the nodes the packs claim in the method this node is, or is
 * written in, for a reader of its body to skip. Undefined when nothing is
 * claimed there.
 */
export function claimedIn(
  node: RbNode,
  facts: Database | undefined,
): ReadonlySet<number> | undefined {
  const ids = registryOf(facts)?.claimsAround(node)?.ids;
  return ids === undefined || ids.size === 0 ? undefined : ids;
}

/**
 * Whether a reader of a body stops at this node, because a pack claims it
 * as a unit of its own and what it does goes on that unit's summary.
 * Every walk over a method's body asks this with the ids `claimedIn` gave.
 */
export function isClaimed(
  node: RbNode,
  claimed: ReadonlySet<number> | undefined,
): boolean {
  return claimed?.has(node.id) === true;
}

/** Every call under the node. The blocks and lambdas in `claimed` are left out. */
export function callsUnder(
  node: RbNode,
  claimed: ReadonlySet<number> | undefined,
  found: RbNode[] = [],
): RbNode[] {
  for (const child of children(node)) {
    if (isClaimed(child, claimed)) {
      continue;
    }
    if (child.type === "call") {
      found.push(child);
    }
    callsUnder(child, claimed, found);
  }
  return found;
}

/** The blocks and lambdas `method` claims, each with the name its unit gets when the method is called `name`. */
export function claimsNamedAfter(
  method: RbNode,
  name: string,
  facts: Database | undefined,
): NamedClaim[] {
  return registryOf(facts)?.claimsNamedAfter(method, name) ?? [];
}

/**
 * The statements of a block or lambda a pack claims, read with the locals
 * of the method it is written in and with the other claims left out. Null
 * for a node no pack claims.
 */
export function claimedBodyOf(
  node: RbNode,
  facts: Database | undefined,
): ReadableBody | null {
  const claims = registryOf(facts)?.claimerOf(node) ?? null;
  const body = claims === null ? null : statementsOf(node);
  if (claims === null || body === null) {
    return null;
  }
  return {
    body,
    locals: claims.locals,
    stops: OWN_BODY_TYPES,
    claimed: claims.ids,
  };
}

/** The method that claims this block or lambda, or null when no pack claims it. */
export function claimingMethodOf(
  node: RbNode,
  facts: Database | undefined,
): RbNode | null {
  return registryOf(facts)?.claimerOf(node)?.method ?? null;
}

/** The blocks and lambdas the packs claim in this method, for the reach walk to start from. */
export function claimedNodesOf(
  method: RbNode,
  facts: Database | undefined,
): readonly RbNode[] {
  const registry = registryOf(facts);
  if (registry === undefined || !METHOD_TYPES.has(method.type)) {
    return [];
  }
  return registry.claimsOf(method)?.nodes ?? [];
}
