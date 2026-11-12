/**
 * The lambdas a pack claims as units of their own, such as a callback a
 * job queue runs later, and the summary each one gets.
 *
 * Python reads a unit's body while it discovers the unit, before anything
 * knows the unit is a parent. So the first time a reader lists a
 * function's calls, the packs' `subUnits` hooks run over that function,
 * and the lambdas they claim are left out of its body from then on. Once
 * every summary is assembled, each summary at a function with claims gets
 * one more summary per claim. DESIGN.md, under "A callback a declared
 * pack claims", says which functions can be parents and what a claim's
 * summary has.
 */

import {
  assembleSummary,
  claimBinding,
  runPackHook,
  stampClaimMetadata,
} from "@suss/extractor";
import { factCallOps } from "@suss/recognize/ops";
import { fileOfKey } from "@suss/resolution";

import { enclosingFunction, field, rangeOf, spanOf } from "./ast.js";
import { effectsBesidesCalls } from "./discovery.js";
import { returnTerminal } from "./exits.js";
import { pythonFactSource } from "./factSource.js";
import { callsRunBy } from "./facts/resolve.js";
import { registerLambdaClaims } from "./lambdaClaims.js";
import { expressionInvocationEffects, ownBodyCalls } from "./paths/effects.js";
import { resolutionKeyOf } from "./values/evaluator.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type { Database } from "@suss/datalog";
import type {
  CallOps,
  DiscoveredSubUnit,
  DiscoveredSubUnitParent,
  ExtractorOptions,
  FactSource,
  PackTally,
  RawCodeStructure,
  SubUnitOpsCarrier,
} from "@suss/extractor";
import type { LambdaClaims, NamedClaim } from "./lambdaClaims.js";
import type { PythonPack } from "./pack.js";
import type { PyNode } from "./parser.js";
import type { BoundPythonFile } from "./routers.js";
import type { StorageLookup } from "./storage.js";

/** A pack's `subUnits` hook, beside the pack's name. */
interface ClaimingPack {
  readonly name: string;
  readonly subUnits: NonNullable<PythonPack["subUnits"]>;
}

/** The lambdas the hooks claimed in one function, by node id. */
interface Claimed {
  readonly fn: PyNode;
  readonly lambdas: ReadonlySet<number>;
}

/** What building a claim's summary reads besides the claim. */
export interface SubUnitReading {
  /** The file a summary's `location.file` points at. */
  readonly boundFileOf: (displayPath: string) => BoundPythonFile | undefined;
  readonly storageFor: (file: BoundPythonFile) => StorageLookup | undefined;
  readonly gapHandling: ExtractorOptions["gapHandling"];
}

/** A claim's summary, and the key of the function it was claimed in. */
export interface SubUnitSummary {
  readonly summary: BehavioralSummary;
  readonly parentKey: string;
}

/** Whether some pack has a hook that claims lambdas. */
export function claimsLambdas(packs: readonly PythonPack[]): boolean {
  return packs.some((pack) => pack.subUnits !== undefined);
}

/**
 * The claims for one run, registered for the readers over `db`. Null when
 * no pack has a `subUnits` hook, and then nothing is registered. A hook
 * that throws goes on its pack's tally.
 */
export function subUnitClaims(
  db: Database,
  packs: readonly PythonPack[],
  tallies: ReadonlyMap<string, PackTally>,
): SubUnitClaims | null {
  const claiming = packs.flatMap((pack) =>
    pack.subUnits === undefined
      ? []
      : [{ name: pack.name, subUnits: pack.subUnits }],
  );
  if (claiming.length === 0) {
    return null;
  }
  const claims = new SubUnitClaims(db, claiming, tallies);
  registerLambdaClaims(db, claims);
  return claims;
}

const NONE: ReadonlySet<number> = new Set();

/**
 * The kind a function is handed to the hooks as while its body is read,
 * before any summary of it says what it is.
 */
const KIND_WHILE_READING = "library";

export class SubUnitClaims implements LambdaClaims {
  private readonly claimed = new Map<string, Claimed>();
  private readonly context: SubUnitOpsCarrier;

  constructor(
    private readonly db: Database,
    private readonly packs: readonly ClaimingPack[],
    private readonly tallies: ReadonlyMap<string, PackTally>,
  ) {
    const source = pythonFactSource(db);
    this.context = {
      calls: (parent) => this.callsOf(parent.func as PyNode, source),
    };
  }

  /**
   * The lambdas claimed in this function. A lambda that the function
   * around it claims has that function's claims, so a reader of the
   * lambda's own body leaves out the claims inside it and never runs the
   * hooks with the lambda as a parent.
   */
  claimedIn(fn: PyNode): ReadonlySet<number> {
    const around = fn.type === "lambda" ? enclosingFunction(fn) : null;
    const outer = around === null ? NONE : this.claimedIn(around);
    return outer.has(fn.id) ? outer : this.ownClaims(fn);
  }

  claimsNamedAfter(fn: PyNode, name: string): NamedClaim[] {
    const key = resolutionKeyOf(fn, this.db);
    const lambdas = this.ownClaims(fn);
    if (key === null || lambdas.size === 0) {
      return [];
    }
    return this.subUnitsOf({ func: fn, name, kind: KIND_WHILE_READING }, key)
      .filter((one) => lambdas.has((one.func as PyNode).id))
      .map((one) => ({ lambda: one.func as PyNode, name: one.name }));
  }

  /** What the hooks claim in this function's own body, run once per function. */
  private ownClaims(fn: PyNode): ReadonlySet<number> {
    const key = resolutionKeyOf(fn, this.db);
    if (key === null) {
      return NONE;
    }
    const known = this.claimed.get(key);
    if (known !== undefined) {
      return known.lambdas;
    }
    // The parent's name goes only into a claim's name, and those are made
    // again from the parent's summary once it has one.
    const lambdas = new Set(
      this.subUnitsOf(
        {
          func: fn,
          name: field(fn, "name")?.text ?? "",
          kind: KIND_WHILE_READING,
        },
        key,
      ).map((one) => (one.func as PyNode).id),
    );
    this.claimed.set(key, { fn, lambdas });
    return lambdas;
  }

  /**
   * One summary per claim for every summary at a function the hooks
   * claimed in. A method reached on a subclass has the same claims as
   * its plain summary, which gets them.
   */
  summariesFor(
    parents: readonly BehavioralSummary[],
    reading: SubUnitReading,
  ): SubUnitSummary[] {
    return parents.flatMap((parent) => {
      const file = reading.boundFileOf(parent.location.file);
      const span = parent.location.span;
      if (
        file === undefined ||
        span === undefined ||
        parent.receiverClass !== undefined
      ) {
        return [];
      }
      const parentKey = `${file.file}:${span.start}-${span.end}`;
      const claimed = this.claimed.get(parentKey);
      if (claimed === undefined || claimed.lambdas.size === 0) {
        return [];
      }
      const subUnits = this.subUnitsOf(
        {
          func: claimed.fn,
          name: parent.identity.name,
          kind: parent.kind,
        },
        parentKey,
      );
      return subUnits.map((subUnit) => ({
        summary: subUnitSummary(subUnit, parent, {
          file,
          storage: reading.storageFor(file),
          facts: this.db,
          gapHandling: reading.gapHandling,
        }),
        parentKey,
      }));
    });
  }

  /**
   * Every hook's claims, the first claim of a lambda kept when two hooks
   * claim it. `parentKey` says which file a hook that throws was reading.
   */
  private subUnitsOf(
    parent: DiscoveredSubUnitParent,
    parentKey: string,
  ): DiscoveredSubUnit[] {
    const seen = new Set<number>();
    const file = fileOfKey(parentKey);
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
        const id = (one.func as PyNode).id;
        if (seen.has(id)) {
          return false;
        }
        seen.add(id);
        return true;
      });
  }

  /** The calls a function's body runs, as the ops a declared pack's recognizer gets for each. */
  private callsOf(fn: PyNode, source: FactSource): CallOps[] {
    const key = resolutionKeyOf(fn, this.db);
    if (key === null) {
      return [];
    }
    return callsRunBy(this.db, key).flatMap((call) => {
      const ops = factCallOps(call, source);
      return ops === null ? [] : [ops];
    });
  }
}

/** What one claim's summary is built from besides the claim and its parent. */
interface ClaimReading {
  readonly file: BoundPythonFile;
  readonly storage: StorageLookup | undefined;
  readonly facts: Database;
  readonly gapHandling: ExtractorOptions["gapHandling"];
}

function subUnitSummary(
  subUnit: DiscoveredSubUnit,
  parent: BehavioralSummary,
  reading: ClaimReading,
): BehavioralSummary {
  const lambda = subUnit.func as PyNode;
  const calls = ownBodyCalls(lambda, reading.facts);
  // A lambda is one expression, so none of its effects runs under a
  // condition and every one of them goes on its one branch.
  const besidesCalls = effectsBesidesCalls(
    lambda,
    reading.file.module,
    reading.storage,
    reading.facts,
  ).map(({ effect }) => effect);
  const range = rangeOf(lambda);
  const raw: RawCodeStructure = {
    identity: {
      name: subUnit.name,
      nameKind: parent.identity.nameKind === "label" ? "label" : "binding",
      kind: subUnit.kind,
      file: parent.location.file,
      range,
      span: spanOf(lambda),
      exportName: null,
      exportPath: null,
    },
    boundaryBinding: claimBinding(parent, subUnit.kind),
    parameters: [],
    branches: [
      {
        conditions: [],
        terminal: returnTerminal(null, range),
        effects: expressionInvocationEffects(calls, reading.facts),
        ...(besidesCalls.length === 0 ? {} : { extraEffects: besidesCalls }),
        location: range,
        isDefault: true,
      },
    ],
    bodyContent: "statements",
    dependencyCalls: [],
    declaredContract: null,
  };
  const summary = assembleSummary(raw, { gapHandling: reading.gapHandling });
  stampClaimMetadata(summary, subUnit);
  summary.confidence = { source: "inferred_static", level: "medium" };
  return summary;
}
