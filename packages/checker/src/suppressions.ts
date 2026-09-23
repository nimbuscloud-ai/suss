/**
 * Applies .sussignore rules to behavioural findings.
 *
 * The rule format, and how a matching rule is applied, live in
 * @suss/ir-core so the intent checker can share them without depending
 * on this package. This module decides whether a rule's `boundary`,
 * `consumer` and `provider` match a two-sided `Finding`: the boundary
 * by key, and each side by summary and transition id.
 *
 * The CLI reads the rule file from disk and passes the parsed rules in.
 */

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
 * Whether a rule's `summary` refers to this summary. An exact match
 * counts. So does a rule that gives a document by file name alone, such
 * as `cloudformation:template.yaml`, which matches every document from
 * that reader with that file name. Rules written before document labels
 * included the path look like that, and this keeps them matching the
 * same documents. A rule with a path, or with no reader label, needs
 * the exact match.
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
 * Dedupe keeps one finding per group and lists the other providers in
 * `sources`, so a rule that gives any of them matches.
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
