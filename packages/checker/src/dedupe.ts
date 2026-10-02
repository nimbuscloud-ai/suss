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

import { boundaryKey } from "./pairing/pairing.js";
import { normalizedDescription } from "./since/findingIdentity.js";

import type { Finding, FindingSeverity } from "@suss/behavioral-ir";

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
    // A finding about the document alone has it on both sides.
    const provider =
      f.provider.summary === f.consumer.summary
        ? ""
        : `${f.provider.summary}|${f.provider.transitionId ?? ""}`;
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
