/**
 * What a Ruby run hands a declared pack's `subUnits` hook, and the
 * summary each block or lambda the hook claims gets.
 *
 * The hook reads the calls the parent method runs, its blocks and the
 * lambdas written as arguments included, from the `runsCall` facts, as
 * the ops a declared recognizer gets for each call. A claimed block's
 * summary is read from its statements the way a method's body is: the
 * calls it makes and everything else it does, and one branch per path
 * it returns or raises on. The claims inside it are left out, since each
 * has a summary of its own.
 */

import {
  assembleSummary,
  claimBinding,
  stampClaimMetadata,
} from "@suss/extractor";
import { factCallOps } from "@suss/recognize/ops";
import { callsRun } from "@suss/resolution";

import { rangeOf, spanOf } from "./ast.js";
import { claimedBodyOf, claimingPacksIn, registerSubUnits } from "./claims.js";
import { effectsBesidesCalls } from "./discovery.js";
import { rubyFactSource } from "./factSource.js";
import { RUBY_PROGRAM } from "./facts/resolve.js";
import { nodeId } from "./facts/values.js";
import {
  EVERY_ARGLESS_CALL,
  effectSitesIn,
  invocationSitesIn,
} from "./paths/effects.js";
import { dropPropertyReads } from "./reach/closure.js";
import { raiseEndings } from "./responseHandOff.js";
import {
  returnPathBranches,
  returnTerminal,
  withEffectsThatRun,
} from "./responseStatus.js";
import { claimedBlockStorage } from "./storage.js";
import { boundFileOf } from "./values/evaluator.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type { Database } from "@suss/datalog";
import type {
  CallOps,
  DiscoveredSubUnit,
  ExtractorOptions,
  PackTally,
  RawBranch,
  RawCodeStructure,
  SubUnitOpsCarrier,
} from "@suss/extractor";
import type { MethodClaims, SubUnitRegistry } from "./claims.js";
import type { RbJobOptions } from "./jobs.js";
import type { RubyPack } from "./pack.js";
import type { RbNode } from "./parser.js";
import type { InheritedMethods } from "./paths/effects.js";
import type { RbStorageOptions } from "./storage.js";

/**
 * Starts the run's sub-unit registry over `db` when some pack claims
 * sub-units, or returns null without doing anything else. A hook that
 * throws goes on its pack's tally in `tallies`.
 */
export function startSubUnits(
  db: Database,
  packs: readonly RubyPack[],
  tallies: ReadonlyMap<string, PackTally>,
): SubUnitRegistry | null {
  const claiming = claimingPacksIn(packs);
  return claiming.length === 0
    ? null
    : registerSubUnits(db, claiming, rubySubUnitContext(db), tallies);
}

/**
 * The context a `subUnits` hook gets in Ruby. Each method's calls are
 * asked once, since the hooks run over a method again to name its
 * sub-units after the parent's summary.
 */
export function rubySubUnitContext(db: Database): SubUnitOpsCarrier {
  const source = rubyFactSource(db);
  const known = new Map<string, readonly CallOps[]>();
  return {
    calls: (parent) => {
      const method = parent.func as RbNode;
      const file = boundFileOf(method);
      if (file === undefined) {
        return [];
      }
      const key = nodeId(file, method);
      const asked = known.get(key);
      if (asked !== undefined) {
        return asked;
      }
      const calls = (callsRun(db, [key], RUBY_PROGRAM).get(key) ?? []).flatMap(
        (call) => {
          const ops = factCallOps(call, source);
          return ops === null ? [] : [ops];
        },
      );
      known.set(key, calls);
      return calls;
    },
  };
}

/** What building a claimed block's summary reads, the same things its parent's body is read with. */
export interface SubUnitReading {
  readonly registry: SubUnitRegistry;
  readonly facts: Database;
  readonly displayPathOf: (file: string) => string;
  readonly storage?: RbStorageOptions | undefined;
  readonly jobs?: RbJobOptions | undefined;
  readonly inheritedMethods: InheritedMethods;
  readonly gapHandling: ExtractorOptions["gapHandling"];
  /** The no-argument calls the reach walk found to be property reads, by the key it scanned a body under. */
  readonly propertyReadsByKey: ReadonlyMap<string, ReadonlySet<string>>;
}

/** A claimed block's summary, beside the key the reach walk scanned the block under. */
export interface SubUnitSummary {
  readonly key: string;
  readonly summary: BehavioralSummary;
}

/**
 * One summary for each block a pack claims, for each summary of the
 * method it is written in. `parents` lists each method's summaries by
 * the method's key. The hooks run again over the method with each
 * parent's name and kind, since a sub-unit is named after its parent.
 */
export function subUnitSummaries(
  parents: Iterable<readonly [string, readonly BehavioralSummary[]]>,
  reading: SubUnitReading,
): SubUnitSummary[] {
  return [...parents].flatMap(([key, summaries]) => {
    const claims = reading.registry.claimsByKey(key);
    return claims === undefined
      ? []
      : summaries.flatMap((parent) => claimsOf(parent, claims, reading));
  });
}

function claimsOf(
  parent: BehavioralSummary,
  claims: MethodClaims,
  reading: SubUnitReading,
): SubUnitSummary[] {
  return reading.registry
    .subUnitsOf(
      {
        func: claims.method,
        name: parent.identity.name,
        kind: parent.kind,
      },
      claims.file,
    )
    .filter((subUnit) => claims.ids.has((subUnit.func as RbNode).id))
    .map((subUnit) => {
      const key = nodeId(claims.file, subUnit.func as RbNode);
      const raw = subUnitStructure(subUnit, parent, claims, reading);
      dropPropertyReads(raw, reading.propertyReadsByKey.get(key));
      const summary = assembleSummary(raw, {
        gapHandling: reading.gapHandling,
      });
      stampClaimMetadata(summary, subUnit);
      summary.confidence = { source: "inferred_static", level: "medium" };
      return { key, summary };
    });
}

function subUnitStructure(
  subUnit: DiscoveredSubUnit,
  parent: BehavioralSummary,
  claims: MethodClaims,
  reading: SubUnitReading,
): RawCodeStructure {
  const node = subUnit.func as RbNode;
  const read = claimedBodyOf(node, reading.facts);
  const range = rangeOf(node);
  // Every call with no arguments goes on the list, and the ones the reach
  // walk found to be property reads come off it.
  const effects =
    read === null
      ? []
      : invocationSitesIn(
          read,
          reading.inheritedMethods,
          EVERY_ARGLESS_CALL,
          reading.facts,
        );
  const found = effectsBesidesCalls(
    {
      root: node,
      method: claims.method,
      file: claims.file,
      claimed: claims.ids,
    },
    reading.storage === undefined
      ? []
      : claimedBlockStorage(node, claims.method, claims.file, reading.storage),
    reading,
  );
  const siteOf = effectSitesIn(
    read,
    found.map((one) => one.at),
  );
  const extraEffects = found.map(({ effect, at }) => ({
    effect,
    site: siteOf(at),
  }));
  const paths = returnPathBranches(
    node,
    effects,
    [],
    reading.facts,
    undefined,
    raiseEndings(node, reading.facts),
  ) ?? [onlyReturn(range)];
  return {
    identity: {
      name: subUnit.name,
      kind: subUnit.kind,
      file: reading.displayPathOf(claims.file),
      range,
      span: spanOf(node),
      exportName: null,
      exportPath: null,
    },
    boundaryBinding: claimBinding(parent, subUnit.kind),
    parameters: [],
    branches: paths.map((branch) =>
      withEffectsThatRun(branch, { effects, extraEffects }),
    ),
    bodyContent: read === null ? "empty" : "statements",
    dependencyCalls: [],
    declaredContract: null,
  };
}

/** The one branch of a block with no statements, which returns. */
function onlyReturn(range: RawBranch["location"]): RawBranch {
  return {
    conditions: [],
    terminal: returnTerminal(range),
    effects: [],
    location: range,
    isDefault: true,
  };
}
