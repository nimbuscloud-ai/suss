/**
 * Who calls each entry point, and what `check` found between them.
 *
 * A caller is a unit `check` paired with the entry: a fetch or axios
 * call for a route, a GraphQL operation for a field. A spec on the
 * consumer side declares the entry rather than calling it, so it is not
 * listed as a caller.
 */

import { summaryIdentifier, summaryRef } from "@suss/behavioral-ir";

import type { BehavioralSummary, Finding } from "@suss/behavioral-ir";
import type { CheckAllResult } from "@suss/checker";
import type { GatheredEntries } from "./mapEntries.js";
import type {
  MapCheck,
  MapClient,
  MapFinding,
  MapOperation,
} from "./mapModel.js";
import type { UnitTable } from "./mapUnits.js";

export interface GatheredCallers {
  operations: MapOperation[];
  clients: MapClient[];
  findings: MapFinding[];
  check: MapCheck;
}

export function gatherCallers(
  gathered: GatheredEntries,
  summaries: readonly BehavioralSummary[],
  check: CheckAllResult,
  units: UnitTable,
): GatheredCallers {
  const byId = indexBy(summaries, summaryIdentifier);
  const byRef = indexBy(summaries, summaryRef);
  const operations = operationsIn(summaries, units);
  const clients = clientsIn(summaries, units);
  const operationOf = new Map(operations.map((op) => [op.unit, op]));
  const clientOf = new Map(clients.map((client) => [client.unit, client]));

  for (const pair of check.pairs) {
    for (const provider of byId.get(pair.provider) ?? []) {
      const index = gathered.entryOf.get(provider);
      const entry = index === undefined ? undefined : gathered.entries[index];
      if (index === undefined || entry === undefined) {
        continue;
      }
      for (const consumer of byId.get(pair.consumer) ?? []) {
        if (units.isSpec(consumer)) {
          continue;
        }
        const unit = units.of(consumer);
        addOnce(entry.callers, unit);
        const operation = operationOf.get(unit);
        if (operation !== undefined) {
          addOnce(operation.fields, index);
        }
        const client = clientOf.get(unit);
        if (client !== undefined) {
          addOnce(client.entries, index);
        }
      }
    }
  }

  const findings = check.findings.map((finding, at) => {
    const placed = placeFinding(finding, gathered, byId, byRef, units);
    if (placed.entry !== null) {
      gathered.entries[placed.entry]?.findings.push(at);
    }
    return placed;
  });

  return {
    operations,
    clients,
    findings,
    check: { pairs: check.pairs.length, byKind: countByKind(check.findings) },
  };
}

function placeFinding(
  finding: Finding,
  gathered: GatheredEntries,
  byId: ReadonlyMap<string, BehavioralSummary[]>,
  byRef: ReadonlyMap<string, BehavioralSummary[]>,
  units: UnitTable,
): MapFinding {
  const providers = lookUp(finding.provider.summary, byId, byRef);
  const consumers = lookUp(finding.consumer.summary, byId, byRef);
  const provider =
    providers.find((s) => gathered.entryOf.has(s)) ?? providers[0];
  const consumer = consumers[0];
  const entry =
    provider === undefined ? undefined : gathered.entryOf.get(provider);
  return {
    kind: finding.kind,
    severity: finding.severity,
    description: finding.description,
    entry: entry ?? null,
    provider: sidePlace(provider, finding.provider.transitionId, units),
    consumer: sidePlace(consumer, finding.consumer.transitionId, units),
  };
}

/** The unit on one side of a finding, and the line of the transition it points at. */
function sidePlace(
  summary: BehavioralSummary | undefined,
  transitionId: string | undefined,
  units: UnitTable,
): { unit: number | null; line: number | null } {
  if (summary === undefined || units.isSpec(summary)) {
    return { unit: null, line: null };
  }
  const transition = summary.transitions.find((t) => t.id === transitionId);
  return {
    unit: units.of(summary),
    line: transition?.location.start ?? null,
  };
}

/** A finding refers to a side by its summary ref, and a pair by its id, so both are tried. */
function lookUp(
  name: string,
  byId: ReadonlyMap<string, BehavioralSummary[]>,
  byRef: ReadonlyMap<string, BehavioralSummary[]>,
): BehavioralSummary[] {
  return byId.get(name) ?? byRef.get(name) ?? [];
}

function operationsIn(
  summaries: readonly BehavioralSummary[],
  units: UnitTable,
): MapOperation[] {
  const atPlace = new Map<string, BehavioralSummary>();
  for (const summary of summaries) {
    if (summary.kind !== "client" && summary.location.span !== undefined) {
      atPlace.set(placeKey(summary), summary);
    }
  }

  const operations: MapOperation[] = [];
  for (const summary of summaries) {
    const semantics = summary.identity.boundaryBinding?.semantics as
      | Record<string, unknown>
      | undefined;
    if (
      summary.kind !== "client" ||
      semantics?.name !== "graphql-operation" ||
      units.isSpec(summary)
    ) {
      continue;
    }
    // The adapter records an operation at the place of the function it
    // is written in, so the function at the same place runs it.
    const owner = atPlace.get(placeKey(summary));
    operations.push({
      unit: units.of(summary),
      type: String(semantics.operationType ?? "query"),
      name: String(semantics.operationName ?? summary.identity.name),
      owner: owner === undefined ? null : units.of(owner),
      fields: [],
    });
  }
  return operations;
}

function clientsIn(
  summaries: readonly BehavioralSummary[],
  units: UnitTable,
): MapClient[] {
  const clients: MapClient[] = [];
  for (const summary of summaries) {
    const semantics = summary.identity.boundaryBinding?.semantics as
      | Record<string, unknown>
      | undefined;
    if (
      summary.kind !== "client" ||
      semantics?.name !== "rest" ||
      units.isSpec(summary)
    ) {
      continue;
    }
    clients.push({
      unit: units.of(summary),
      method:
        typeof semantics.method === "string"
          ? semantics.method.toUpperCase()
          : null,
      path: typeof semantics.path === "string" ? semantics.path : null,
      entries: [],
    });
  }
  return clients;
}

function placeKey(summary: BehavioralSummary): string {
  const { workspace, file, span } = summary.location;
  return `${workspace ?? ""}\u0000${file}\u0000${span?.start}\u0000${span?.end}`;
}

function indexBy(
  summaries: readonly BehavioralSummary[],
  key: (summary: BehavioralSummary) => string,
): Map<string, BehavioralSummary[]> {
  const index = new Map<string, BehavioralSummary[]>();
  for (const summary of summaries) {
    const name = key(summary);
    index.set(name, [...(index.get(name) ?? []), summary]);
  }
  return index;
}

function addOnce(list: number[], value: number): void {
  if (!list.includes(value)) {
    list.push(value);
  }
}

function countByKind(findings: readonly Finding[]): MapCheck["byKind"] {
  const counts = new Map<string, MapCheck["byKind"][number]>();
  for (const finding of findings) {
    const key = `${finding.kind} ${finding.severity}`;
    const seen = counts.get(key);
    if (seen === undefined) {
      counts.set(key, {
        kind: finding.kind,
        severity: finding.severity,
        count: 1,
      });
      continue;
    }
    seen.count += 1;
  }
  return [...counts.values()].sort((a, b) => b.count - a.count);
}
