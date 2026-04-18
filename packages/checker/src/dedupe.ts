// dedupe.ts — Collapse identical findings produced by overlapping providers.
//
// When a boundary is described by more than one provider summary
// (e.g. an OpenAPI stub AND a CloudFormation stub for the same REST
// endpoint), each provider pairs independently with every consumer,
// and the checker emits N findings where one would do. This pass
// collapses identical findings into a single representative carrying
// the list of contributing provider-summary identifiers in
// `finding.sources`.
//
// Two findings are "identical" iff they agree on:
//   - kind
//   - boundary key (method + normalized path, HTTP-shaped today)
//   - description
//   - consumer identity (summary + transitionId)
//
// Provider identity is explicitly *not* part of the key — that is the
// axis we are collapsing across. The first finding seen wins as the
// representative; its `provider` field is unchanged. `sources` lists
// every contributing provider-summary identifier, sorted
// deterministically for stable output.

import { boundaryKey } from "./pairing.js";

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
  const key = boundaryKey(f.boundary) ?? "_noboundary_";
  // description is freeform text — if two checks ever produced
  // descriptions that differed only in trivial whitespace, that would
  // foil dedup. Normalize whitespace before keying.
  const desc = f.description.replace(/\s+/g, " ").trim();
  const consumerTxn = f.consumer.transitionId ?? "";
  return `${f.kind}|${key}|${desc}|${f.consumer.summary}|${consumerTxn}`;
}

/**
 * Collapse identical findings across overlapping provider summaries.
 *
 * Input order is preserved for the representative of each collapsed
 * group. When two findings collapse, the representative keeps the
 * most-severe severity observed and unions the `sources` lists.
 *
 * Safe to call on a single-provider result — single-source findings
 * pass through untouched with `sources` unset.
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
    // Seed with representative's contributor (either its existing list
    // or its own provider.summary when it hasn't been collapsed before).
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
