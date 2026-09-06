/**
 * contractStatusGaps.ts: the statuses a unit's declared contract and its
 * outcomes disagree on, as gaps on the unit.
 *
 * A route declares its responses in one place, a router declaration or
 * a route object, and produces them somewhere else, and the two drift.
 * The comparison runs when a summary is assembled from the handler's
 * own body and again once the wrappers registered around the route are
 * composed in, since a middleware's 401 is one of the route's outcomes
 * and a contract that declares it is right to.
 */

import { readWrapperMetadata } from "@suss/behavioral-ir";

import type { Gap, Transition } from "@suss/behavioral-ir";

/** The part of a declared contract the status comparison reads. */
export interface DeclaredStatuses {
  framework: string;
  responses: readonly { statusCode: number }[];
}

export function contractStatusGaps(
  contract: DeclaredStatuses,
  transitions: readonly Transition[],
): Gap[] {
  const producers = producersByStatus(transitions);
  const declared = new Set(contract.responses.map((r) => r.statusCode));
  const gaps: Gap[] = [];

  for (const status of declared) {
    if (!producers.has(status)) {
      gaps.push({
        type: "unhandledCase",
        conditions: [],
        consequence: "frameworkDefault",
        description: `Declared response ${status} is never produced by the handler`,
      });
    }
  }

  for (const [status, wrappers] of producers) {
    if (declared.has(status)) {
      continue;
    }
    gaps.push({
      type: "unhandledCase",
      conditions: [],
      consequence: "unknown",
      description: `${producerOf(wrappers)} produces status ${status} which is not declared in the ${contract.framework} contract`,
    });
  }

  return gaps;
}

/**
 * Each literal status the transitions respond with, against which
 * wrappers produced it. An empty set means the unit's own body
 * produced it, whether or not a wrapper did as well.
 */
function producersByStatus(
  transitions: readonly Transition[],
): Map<number, Set<string>> {
  const producers = new Map<number, Set<string>>();
  for (const transition of transitions) {
    if (transition.output.type !== "response") {
      continue;
    }
    const status = transition.output.statusCode;
    if (status?.type !== "literal" || typeof status.value !== "number") {
      continue;
    }
    const from = readWrapperMetadata(transition)?.from;
    const seen = producers.get(status.value);
    if (seen === undefined) {
      producers.set(
        status.value,
        new Set(from === undefined ? [] : [from.name]),
      );
    } else if (from === undefined) {
      seen.clear();
    } else if (seen.size > 0) {
      seen.add(from.name);
    }
  }
  return producers;
}

function producerOf(wrappers: ReadonlySet<string>): string {
  if (wrappers.size === 0) {
    return "Handler";
  }
  return `${[...wrappers].sort().join(" and ")}, registered around this handler,`;
}
