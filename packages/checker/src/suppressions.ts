// suppressions.ts — apply .sussignore rules to behavioural findings.
//
// The pipeline (rule shape, first-match-wins, effect application,
// threshold counting) lives in @suss/ir-core so the intent checker
// shares it without depending on this package; the rule types are
// re-exported here for existing consumers. What this module owns is
// the behavioural matcher: how a rule's `boundary` / `consumer` /
// `provider` discriminators match a two-sided `Finding` (boundary key
// computed from the finding's BoundaryBinding, per-side summary and
// transitionId compared directly).
//
// File I/O stays out — the CLI reads .sussignore.yml / .sussignore.json
// from disk and hands the parsed rules here.

import {
  applySuppressionsToFindings,
  ruleBoundaryMatchesKey,
} from "@suss/ir-core";

import { boundaryKey } from "./pairing/pairing.js";

import type { Finding } from "@suss/behavioral-ir";
import type { SuppressionRule } from "@suss/ir-core";

export {
  countsForThreshold,
  type SuppressionFile,
  SuppressionFileSchema,
  type SuppressionRule,
  SuppressionRuleSchema,
  validateRule,
} from "@suss/ir-core";

/**
 * Both sides of a finding carry the same two discriminators, so one
 * helper answers for either side.
 */
function ruleSideMatches(
  side: SuppressionRule["consumer"],
  findingSide: Finding["consumer"],
): boolean {
  if (side === undefined) {
    return true;
  }
  if (side.summary !== undefined && side.summary !== findingSide.summary) {
    return false;
  }
  if (
    side.transitionId !== undefined &&
    side.transitionId !== findingSide.transitionId
  ) {
    return false;
  }
  return true;
}

function ruleMatchesFinding(rule: SuppressionRule, finding: Finding): boolean {
  if (
    rule.boundary !== undefined &&
    !ruleBoundaryMatchesKey(rule.boundary, boundaryKey(finding.boundary))
  ) {
    return false;
  }
  return (
    ruleSideMatches(rule.consumer, finding.consumer) &&
    ruleSideMatches(rule.provider, finding.provider)
  );
}

/**
 * Apply suppression rules to behavioural findings. See
 * `applySuppressionsToFindings` in @suss/ir-core for the shared
 * semantics (first match wins; `hide` removes unless `keepHidden`).
 */
export function applySuppressions(
  findings: Finding[],
  rules: SuppressionRule[],
  opts: { keepHidden?: boolean } = {},
): Finding[] {
  return applySuppressionsToFindings(findings, rules, ruleMatchesFinding, opts);
}
