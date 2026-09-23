/**
 * Pair the invokes a recognizer found in code against the deployed
 * units a template declares.
 *
 * The two sides rarely write the callee the same way. Code refers to
 * the function through an env var or a full ARN, and the template gives
 * its logical id, so pairing resolves the env var first and then
 * compares names. The ARN is reduced to the name inside it when the
 * effect is recorded, so nothing here sees an ARN.
 */

import {
  deploymentOf,
  summaryIdentifier,
  summaryRef,
} from "@suss/behavioral-ir";
import { boundaryKey, groundBinding, unitIdentityKey } from "@suss/ir-core";

import {
  buildInteractionIndex,
  type InteractionIndex,
  type InteractionRecord,
  interactionsOf,
  providersOf,
} from "../interactions/dispatcher.js";

import type {
  BehavioralSummary,
  BoundaryBinding,
  Finding,
  UnitInvocationSemantics,
} from "@suss/behavioral-ir";
import type { ComparedPair } from "../pairing/comparedPair.js";

/** One invoke, and the unit it turned out to reach. */
interface InvokeRecord {
  record: InteractionRecord<"unit-invoke">;
  semantics: UnitInvocationSemantics;
  /** The identity key this invoke reaches, or null when its target is unsettled. */
  key: string | null;
}

export function checkUnitInvocation(
  summaries: BehavioralSummary[],
  index?: InteractionIndex,
  /** Where to record what this pass compared; see `ComparedPair`. */
  compared?: ComparedPair[],
): Finding[] {
  const idx = index ?? buildInteractionIndex(summaries);
  const units = unitsByKey(providersOf(idx, "unit-invocation"));
  const findings: Finding[] = [];

  for (const invoke of groundedInvokes(idx, summaries)) {
    if (invoke.key === null) {
      continue;
    }
    const reached = units.get(invoke.key);
    if (reached === undefined) {
      findings.push(makeUnknownTargetFinding(invoke));
      continue;
    }
    for (const unit of reached) {
      compared?.push({
        key: invoke.key,
        provider: summaryIdentifier(unit),
        consumer: summaryIdentifier(invoke.record.summary),
      });
    }
  }

  return findings;
}

/**
 * Who invokes each unit in the run, keyed the same way as the unit's
 * own binding. `suss inspect` uses this to tell a function nothing
 * invokes from one something does, without having to know which
 * protocol the invoke went through.
 */
export function invokersOfUnits(summaries: BehavioralSummary[]): InvokesInRun {
  const idx = buildInteractionIndex(summaries);
  const byUnit = new Map<string, BehavioralSummary[]>();
  let unsettled = 0;
  for (const invoke of groundedInvokes(idx, summaries)) {
    if (invoke.key === null) {
      unsettled += 1;
      continue;
    }
    const callers = byUnit.get(invoke.key) ?? [];
    const invoker = invoke.record.summary;
    if (!callers.includes(invoker)) {
      callers.push(invoker);
    }
    byUnit.set(invoke.key, callers);
  }
  return { byUnit, unsettled };
}

/** What the invokes in a run add up to, for a reader asking who calls what. */
export interface InvokesInRun {
  /** The units something invokes, and who invokes each one. */
  byUnit: ReadonlyMap<string, BehavioralSummary[]>;
  /**
   * How many invokes pick their target at run time. Any of them could
   * reach a unit that nothing else invokes, so a report that says
   * nothing invokes a unit should give this count too.
   */
  unsettled: number;
}

/** Every invoke in the run, with env var values from the deployment filled in. */
function groundedInvokes(
  index: InteractionIndex,
  summaries: BehavioralSummary[],
): InvokeRecord[] {
  const deployment = deploymentOf(summaries);
  const invokes: InvokeRecord[] = [];

  for (const record of interactionsOf(
    index,
    "unit-invoke",
    "unit-invocation",
  )) {
    const semantics = record.effect.binding.semantics;
    if (semantics.name !== "unit-invocation") {
      continue;
    }
    invokes.push({
      record,
      semantics,
      key: boundaryKey(
        groundBinding(record.effect.binding, deployment(record.summary)),
      ),
    });
  }
  return invokes;
}

/** The units in the run, by the key their own binding gives. */
function unitsByKey(
  units: BehavioralSummary[],
): ReadonlyMap<string, BehavioralSummary[]> {
  const byKey = new Map<string, BehavioralSummary[]>();
  for (const unit of units) {
    const semantics = unit.identity.boundaryBinding?.semantics;
    if (semantics?.name !== "unit-invocation") {
      continue;
    }
    if (semantics.instanceName === null) {
      continue;
    }
    const key = unitIdentityKey(
      semantics.deploymentTarget,
      semantics.instanceName,
    );
    byKey.set(key, [...(byKey.get(key) ?? []), unit]);
  }
  return byKey;
}

function makeUnknownTargetFinding(invoke: InvokeRecord): Finding {
  const { record, semantics } = invoke;
  const binding = record.effect.binding as BoundaryBinding;
  const summary = record.summary;
  return {
    kind: "unitInvocationTargetUnknown",
    boundary: binding,
    provider: side(summary, record.transitionId),
    consumer: side(summary, record.transitionId),
    description: `${summary.identity.name} invokes the ${semantics.deploymentTarget} "${semantics.instanceName}", and nothing in the analysed scope deploys a unit by that name. Likely cases: (a) it is deployed by another stack we don't analyse; (b) work-in-progress before the infrastructure is wired up; (c) a name that no longer exists. Severity is warning rather than error because (a) and (b) are common.`,
    severity: "warning",
  };
}

function side(
  summary: BehavioralSummary,
  transitionId: string,
): {
  summary: string;
  location: BehavioralSummary["location"];
  transitionId?: string;
} {
  return {
    summary: summaryRef(summary),
    location: summary.location,
    transitionId,
  };
}
