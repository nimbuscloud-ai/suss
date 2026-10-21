/**
 * Collapses identical findings that overlapping sources produce.
 *
 * Two provider summaries for one boundary, such as an OpenAPI stub and
 * a CloudFormation stub, each pair with every consumer, so the same
 * finding comes once per provider. Those collapse on kind, boundary
 * key, description and consumer side, with the provider left out.
 * A contract document can also be the consumer side, and two documents
 * describing one API then give the same finding once each. For those
 * the document is left out of the key and the provider stays in.
 *
 * The first finding seen is kept with its sides unchanged, and
 * `sources` lists every contributing summary on the side that differs.
 */

import { readWrapperMetadata, summaryRef } from "@suss/behavioral-ir";

import { isContractDocument } from "./contract/declaredContract.js";
import { boundaryKey } from "./pairing/pairing.js";
import {
  boundaryKeyOf,
  normalizedDescription,
} from "./since/findingIdentity.js";

import type {
  BehavioralSummary,
  Finding,
  FindingSeverity,
  Transition,
} from "@suss/behavioral-ir";

const SEVERITY_RANK: Record<FindingSeverity, number> = {
  error: 0,
  warning: 1,
  info: 2,
};

function moreSevere(a: FindingSeverity, b: FindingSeverity): FindingSeverity {
  return SEVERITY_RANK[a] <= SEVERITY_RANK[b] ? a : b;
}

interface Keyed {
  key: string;
  /** The summary on the side the key leaves out. */
  source: string;
}

function keyFor(f: Finding, documents: ReadonlySet<string>): Keyed {
  const key = boundaryKey(f.boundary);
  // Descriptions that differ only in whitespace still collapse.
  const desc = normalizedDescription(f);
  if (documents.has(f.consumer.summary) && key !== null) {
    // A finding about the document alone has it on both sides. Two paths
    // of one handler that earn the same text against a document are one
    // finding, so the provider's transition stays out of the key.
    const provider =
      f.provider.summary === f.consumer.summary ? "" : f.provider.summary;
    return {
      key: `${f.kind}|${key}|${desc}|document|${provider}`,
      source: f.consumer.summary,
    };
  }

  const consumerTxn = f.consumer.transitionId ?? "";
  // Without a boundary key nothing shows that two providers describe one
  // boundary, so the provider stays in the key and each keeps its own
  // finding.
  const boundaryPart = key ?? `_noboundary_|${f.provider.summary}`;
  return {
    key: `${f.kind}|${boundaryPart}|${desc}|${f.consumer.summary}|${consumerTxn}`,
    source: f.provider.summary,
  };
}

/**
 * Which side of a merged finding its `sources` list, or null when the
 * finding was not merged. Contract documents that describe one
 * operation merge on the consumer side, and every other merge is of
 * providers.
 */
export function mergedSideOf(f: Finding): "provider" | "consumer" | null {
  if (f.sources === undefined || f.sources.length < 2) {
    return null;
  }
  const consumerMerged =
    f.consumer.summary !== f.provider.summary &&
    f.sources.includes(f.consumer.summary);
  return consumerMerged ? "consumer" : "provider";
}

/**
 * One finding for each thing a pair disagrees about, with every consumer
 * path that shows it listed on the consumer side. A consumer that tests
 * a status on 40 paths through one callback gets one finding for that
 * status instead of 40, and a `.sussignore` rule for any of its paths
 * still matches it.
 */
export function findingPerConsumerPath(findings: Finding[]): Finding[] {
  const merged = new Map<string, Finding>();
  for (const f of findings) {
    const key = [
      f.kind,
      normalizedDescription(f),
      f.provider.summary,
      f.provider.transitionId ?? "",
      (f.provider.transitionIds ?? []).join(","),
      f.consumer.summary,
    ].join("|");
    const existing = merged.get(key);
    if (existing === undefined) {
      merged.set(key, f);
      continue;
    }
    const paths = new Set([
      ...pathsOf(existing.consumer),
      ...pathsOf(f.consumer),
    ]);
    merged.set(key, {
      ...existing,
      severity: moreSevere(existing.severity, f.severity),
      consumer: { ...existing.consumer, transitionIds: [...paths] },
    });
  }
  return [...merged.values()];
}

function pathsOf(side: Finding["consumer"]): string[] {
  return (
    side.transitionIds ??
    (side.transitionId === undefined ? [] : [side.transitionId])
  );
}

/**
 * Collapse identical findings across overlapping sources. `documents`
 * lists the contract documents in the run, by summary reference, so a
 * finding whose consumer side is one of them collapses across them.
 *
 * Each group keeps the position of its first finding, takes the most
 * severe severity in the group, and merges the `sources` lists. A
 * finding with nothing to collapse into comes back unchanged, with
 * `sources` unset.
 */
export function dedupeFindings(
  findings: Finding[],
  documents: ReadonlySet<string> = new Set(),
): Finding[] {
  const byKey = new Map<string, { finding: Finding; source: string }>();
  const order: string[] = [];

  for (const f of findings) {
    const { key, source } = keyFor(f, documents);
    const existing = byKey.get(key);

    if (existing === undefined) {
      byKey.set(key, { finding: f, source });
      order.push(key);
      continue;
    }

    const sources = new Set<string>(
      existing.finding.sources ?? [existing.source],
    );
    for (const s of f.sources ?? [source]) {
      sources.add(s);
    }

    byKey.set(key, {
      finding: {
        ...existing.finding,
        severity: moreSevere(existing.finding.severity, f.severity),
        sources: [...sources].sort(),
      },
      source: existing.source,
    });
  }

  return order.map((key) => (byKey.get(key) as { finding: Finding }).finding);
}

/** Where a provider outcome is written: a wrapper, or the unit's own body. */
export interface OutcomeOrigin {
  file: string;
  name: string;
  line: number;
}

/**
 * Findings that one provider outcome gives at different boundaries, in
 * the order the first of them came, or a single finding with `origins`
 * null when nothing else shares its cause.
 */
export interface CauseGroup {
  findings: Finding[];
  origins: OutcomeOrigin[] | null;
}

/**
 * Groups findings that state the same thing about the same provider
 * outcomes, read from where composition says each outcome came from, so
 * a filter that sends one status on 50 routes prints once. Every finding
 * stays in the list, so counts, `--fail-on` and `.sussignore` rules see
 * each one. A finding that cites a consumer path stays on its own,
 * because that path is part of what it says.
 */
export function groupBySharedCause(
  findings: readonly Finding[],
  summaries: readonly BehavioralSummary[],
): CauseGroup[] {
  const providers = summariesByRef(summaries);
  const groups = new Map<string, CauseGroup>();
  const order: CauseGroup[] = [];
  for (const f of findings) {
    const origins = originsOf(f, providers);
    const key = origins === null ? null : causeKey(f, origins);
    const existing = key === null ? undefined : groups.get(key);
    if (existing !== undefined) {
      existing.findings.push(f);
      continue;
    }

    const group: CauseGroup = { findings: [f], origins };
    if (key !== null) {
      groups.set(key, group);
    }
    order.push(group);
  }
  return order.flatMap(splitWhenOneBoundary);
}

// Two summaries of one route can share a cause, and that is one boundary.
function splitWhenOneBoundary(group: CauseGroup): CauseGroup[] {
  const boundaries = new Set(
    group.findings.map((f) => boundaryKeyOf(f.boundary)),
  );
  if (boundaries.size > 1) {
    return [group];
  }
  return group.findings.map((f) => ({ findings: [f], origins: null }));
}

function causeKey(f: Finding, origins: readonly OutcomeOrigin[]): string {
  return JSON.stringify([
    f.kind,
    f.severity,
    f.suppressed?.effect ?? null,
    // Two claims about one outcome, such as its status and its body, stay apart.
    normalizedDescription(f),
    origins.map((o) => `${o.file}:${o.line}:${o.name}`),
  ]);
}

function summariesByRef(
  summaries: readonly BehavioralSummary[],
): Map<string, BehavioralSummary[]> {
  const byRef = new Map<string, BehavioralSummary[]>();
  for (const summary of summaries) {
    const ref = summaryRef(summary);
    const sharing = byRef.get(ref);
    if (sharing === undefined) {
      byRef.set(ref, [summary]);
      continue;
    }
    sharing.push(summary);
  }
  return byRef;
}

/**
 * Where each provider transition a finding cites was written, or null
 * when the finding cites none, cites a consumer path, comes from a
 * contract document, or cites a transition the run does not have.
 */
function originsOf(
  f: Finding,
  providers: ReadonlyMap<string, readonly BehavioralSummary[]>,
): OutcomeOrigin[] | null {
  const cited =
    f.provider.transitionIds ??
    (f.provider.transitionId === undefined ? [] : [f.provider.transitionId]);
  if (cited.length === 0 || f.consumer.transitionId !== undefined) {
    return null;
  }

  const summary = providerOf(f, cited, providers.get(f.provider.summary) ?? []);
  if (summary === undefined || isContractDocument(summary)) {
    return null;
  }
  const origins: OutcomeOrigin[] = [];
  for (const id of cited) {
    const transition = summary.transitions.find((t) => t.id === id);
    if (transition === undefined) {
      return null;
    }
    origins.push(originOf(transition, summary));
  }
  return origins;
}

/** The summary a finding's provider side refers to, out of those sharing its reference. */
function providerOf(
  f: Finding,
  cited: readonly string[],
  candidates: readonly BehavioralSummary[],
): BehavioralSummary | undefined {
  const hasAll = candidates.filter((s) =>
    cited.every((id) => s.transitions.some((t) => t.id === id)),
  );
  const key = boundaryKeyOf(f.boundary);
  return (
    hasAll.find(
      (s) =>
        s.identity.boundaryBinding !== null &&
        boundaryKeyOf(s.identity.boundaryBinding) === key,
    ) ?? hasAll[0]
  );
}

function originOf(
  transition: Transition,
  summary: BehavioralSummary,
): OutcomeOrigin {
  const from = readWrapperMetadata(transition)?.from;
  return {
    file: from?.file ?? summary.location.file,
    name: from?.name ?? summary.identity.name,
    line: transition.location.start,
  };
}
