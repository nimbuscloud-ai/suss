/**
 * Collapses identical findings that overlapping providers produce.
 *
 * When more than one provider summary describes a boundary, such as an
 * OpenAPI stub and a CloudFormation stub for one endpoint, each pairs
 * with every consumer and the checker reports the same thing N times.
 * Two findings count as the same when their kind, boundary key,
 * description and consumer side (summary and transition) all match.
 * The provider is left out of the key because it is what differs.
 *
 * The first finding seen is kept with its `provider` unchanged, and
 * `sources` lists every contributing provider summary, sorted so the
 * output is stable.
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

function keyFor(f: Finding): string {
  const key = boundaryKey(f.boundary);
  // Descriptions that differ only in whitespace still collapse.
  const desc = normalizedDescription(f);
  const consumerTxn = f.consumer.transitionId ?? "";
  // Without a boundary key nothing shows that two providers describe one
  // boundary, so the provider stays in the key and each keeps its own
  // finding.
  const boundaryPart = key ?? `_noboundary_|${f.provider.summary}`;
  return `${f.kind}|${boundaryPart}|${desc}|${f.consumer.summary}|${consumerTxn}`;
}

/**
 * Collapse identical findings across overlapping provider summaries.
 *
 * Each group keeps the position of its first finding, takes the most
 * severe severity in the group, and merges the `sources` lists. A
 * finding with nothing to collapse into comes back unchanged, with
 * `sources` unset.
 */
export function dedupeFindings(findings: Finding[]): Finding[] {
  const byKey = new Map<string, Finding>();
  const order: string[] = [];

  for (const f of findings) {
    const key = keyFor(f);
    const existing = byKey.get(key);

    if (existing === undefined) {
      byKey.set(key, f);
      order.push(key);
      continue;
    }

    const sources = new Set<string>();
    if (existing.sources !== undefined) {
      for (const s of existing.sources) {
        sources.add(s);
      }
    } else {
      sources.add(existing.provider.summary);
    }
    if (f.sources !== undefined) {
      for (const s of f.sources) {
        sources.add(s);
      }
    } else {
      sources.add(f.provider.summary);
    }

    byKey.set(key, {
      ...existing,
      severity: moreSevere(existing.severity, f.severity),
      sources: [...sources].sort(),
    });
  }

  return order.map((key) => byKey.get(key) as Finding);
}
