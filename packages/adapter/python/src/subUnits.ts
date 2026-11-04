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

import { BOUNDARY_ROLE, functionCallBinding } from "@suss/behavioral-ir";
import { assembleSummary } from "@suss/extractor";
import { factCallOps } from "@suss/recognize/ops";

import { field, rangeOf, spanOf } from "./ast.js";
import { returnTerminal } from "./exits.js";
import { pythonFactSource } from "./factSource.js";
import { callsRunBy } from "./facts/resolve.js";
import { registerLambdaClaims } from "./lambdaClaims.js";
import {
  expressionCalls,
  expressionInvocationEffects,
} from "./paths/effects.js";
import { callStorage } from "./storage.js";
import { resolutionKeyOf } from "./values/evaluator.js";

import type { BehavioralSummary, BoundaryBinding } from "@suss/behavioral-ir";
import type { Database } from "@suss/datalog";
import type {
  CallOps,
  DiscoveredSubUnit,
  DiscoveredSubUnitParent,
  ExtractorOptions,
  FactSource,
  RawCodeStructure,
  SubUnitOpsCarrier,
} from "@suss/extractor";
import type { LambdaClaims } from "./lambdaClaims.js";
import type { PythonPack } from "./pack.js";
import type { PyNode } from "./parser.js";
import type { BoundPythonFile } from "./routers.js";
import type { StorageLookup } from "./storage.js";

type SubUnitHook = NonNullable<PythonPack["subUnits"]>;

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
 * no pack has a `subUnits` hook, and then nothing is registered.
 */
export function subUnitClaims(
  db: Database,
  packs: readonly PythonPack[],
): SubUnitClaims | null {
  const hooks = packs.flatMap((pack) =>
    pack.subUnits === undefined ? [] : [pack.subUnits],
  );
  if (hooks.length === 0) {
    return null;
  }
  const claims = new SubUnitClaims(db, hooks);
  registerLambdaClaims(db, claims);
  return claims;
}

const NONE: ReadonlySet<number> = new Set();

export class SubUnitClaims implements LambdaClaims {
  private readonly claimed = new Map<string, Claimed>();
  private readonly context: SubUnitOpsCarrier;

  constructor(
    private readonly db: Database,
    private readonly hooks: readonly SubUnitHook[],
  ) {
    const source = pythonFactSource(db);
    this.context = {
      calls: (parent) => this.callsOf(parent.func as PyNode, source),
    };
  }

  claimedIn(fn: PyNode): ReadonlySet<number> {
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
      this.subUnitsOf({
        func: fn,
        name: field(fn, "name")?.text ?? "",
        kind: "library",
      }).map((one) => (one.func as PyNode).id),
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
      const subUnits = this.subUnitsOf({
        func: claimed.fn,
        name: parent.identity.name,
        kind: parent.kind,
      });
      return subUnits.map((subUnit) => ({
        summary: subUnitSummary(subUnit, parent, {
          barriers: claimed.lambdas,
          storage: reading.storageFor(file),
          facts: this.db,
          gapHandling: reading.gapHandling,
        }),
        parentKey,
      }));
    });
  }

  /** Every hook's claims, the first claim of a lambda kept when two hooks claim it. */
  private subUnitsOf(parent: DiscoveredSubUnitParent): DiscoveredSubUnit[] {
    const seen = new Set<number>();
    return this.hooks
      .flatMap((hook) => hook(parent, this.context))
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
  readonly barriers: ReadonlySet<number>;
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
  const body = field(lambda, "body");
  const calls = body === null ? [] : expressionCalls(body, reading.barriers);
  const recognized =
    reading.storage === undefined
      ? []
      : callStorage(calls, reading.storage).effects.map(({ effect }) => effect);
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
    boundaryBinding: subUnitBinding(parent),
    parameters: [],
    branches: [
      {
        conditions: [],
        terminal: returnTerminal(null, range),
        effects: expressionInvocationEffects(calls, reading.facts),
        ...(recognized.length === 0 ? {} : { extraEffects: recognized }),
        location: range,
        isDefault: true,
      },
    ],
    bodyContent: "statements",
    dependencyCalls: [],
    declaredContract: null,
  };
  const summary = assembleSummary(raw, { gapHandling: reading.gapHandling });
  if (
    subUnit.metadata !== undefined &&
    Object.keys(subUnit.metadata).length > 0
  ) {
    summary.metadata = { ...(summary.metadata ?? {}), ...subUnit.metadata };
  }
  summary.confidence = { source: "inferred_static", level: "medium" };
  return summary;
}

/**
 * A claim runs as part of a unit that serves or runs, so it takes that
 * binding whole. A caller's binding is the call it makes, which is in
 * its own body and never in a lambda inside it, so a lambda there is
 * internal code like a function the call walk reaches.
 */
function subUnitBinding(parent: BehavioralSummary): BoundaryBinding | null {
  const binding = parent.identity.boundaryBinding;
  if (binding === null || BOUNDARY_ROLE[parent.kind] === "provider") {
    return binding;
  }
  return functionCallBinding({
    transport: "in-process",
    recognition: "reachable",
  });
}
