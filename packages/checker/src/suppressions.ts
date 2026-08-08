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
  namesDocumentByFileName,
  parseDocumentLabel,
} from "@suss/behavioral-ir";
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
 * Does a rule's `summary` name this summary? Exact match first. Then
 * the one legacy spelling: a manifest reader used to label a document
 * by its file name alone, so `cloudformation:template.yaml` named every
 * template.yaml a run read at once. The label now carries the path, and
 * an old rule would quietly stop matching, so a rule naming a document
 * by file name still matches that reader's documents with that file
 * name. It matches exactly the set it matched before the label
 * changed, and nothing more: a rule with no reader label (every rule
 * naming source code) and a rule already written with a path both take
 * the exact comparison above.
 */
function summaryMatches(ruleSummary: string, findingSummary: string): boolean {
  if (ruleSummary === findingSummary) {
    return true;
  }

  const named = parseDocumentLabel(ruleSummary);
  const found = parseDocumentLabel(findingSummary);
  if (named === null || found === null || named.reader !== found.reader) {
    return false;
  }

  return (
    namesDocumentByFileName(ruleSummary) &&
    found.location.endsWith(`/${named.location}`)
  );
}

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
  if (
    side.summary !== undefined &&
    !summaryMatches(side.summary, findingSide.summary)
  ) {
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

/**
 * Dedupe keeps one representative and lists the other contributing
 * providers in `sources`; a rule naming any contributor matches.
 */
function providerSideMatches(
  side: SuppressionRule["provider"],
  finding: Finding,
): boolean {
  if (ruleSideMatches(side, finding.provider)) {
    return true;
  }
  if (side?.summary === undefined || side.transitionId !== undefined) {
    return false;
  }

  const named = side.summary;
  return (
    finding.sources?.some((source) => summaryMatches(named, source)) ?? false
  );
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
    providerSideMatches(rule.provider, finding)
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
