/**
 * Applies .sussignore rules to behavioural findings.
 *
 * The rule format, and how a matching rule is applied, live in
 * @suss/ir-core so the intent checker can share them without depending
 * on this package. This module decides whether a rule's `boundary`,
 * `consumer` and `provider` match a two-sided `Finding`: the boundary
 * by key, and each side by summary, transition id and field.
 *
 * The CLI reads the rule file from disk and passes the parsed rules in.
 */

import {
  namesDocumentByFileName,
  parseDocumentLabel,
} from "@suss/behavioral-ir";
import {
  applySuppressionsToFindings,
  findingsAreReadsByName,
  labelWithDetail,
  ruleBoundaryMatchesKey,
} from "@suss/ir-core";

import { mergedSideOf } from "./dedupe.js";
import { boundaryKey } from "./pairing/pairing.js";
import { storageBoundaryKey } from "./storage/storagePairing.js";

import type { BoundaryBinding, Finding } from "@suss/behavioral-ir";
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
    side.transitionId !== findingSide.transitionId &&
    !(findingSide.transitionIds ?? []).includes(side.transitionId)
  ) {
    return false;
  }
  if (side.field !== undefined && side.field !== findingSide.field) {
    return false;
  }
  return true;
}

/**
 * Dedupe keeps one finding per group and lists the other summaries on
 * the side that differed in `sources`, so a rule that gives any of them
 * for that side matches.
 */
function mergedSideMatches(
  side: SuppressionRule["provider"],
  finding: Finding,
  which: "provider" | "consumer",
): boolean {
  if (ruleSideMatches(side, finding[which])) {
    return true;
  }
  if (
    side?.summary === undefined ||
    side.transitionId !== undefined ||
    (side.field !== undefined && side.field !== finding[which].field) ||
    mergedSideOf(finding) !== which
  ) {
    return false;
  }

  const named = side.summary;
  return (
    finding.sources?.some((source) => summaryMatches(named, source)) ?? false
  );
}

function ruleMatchesFinding(rule: SuppressionRule, finding: Finding): boolean {
  if (rule.deployments === undefined) {
    return ruleMatchesBesidesDeployments(rule, finding);
  }
  const names = findingDeployments(finding);
  return (
    names.length > 0 &&
    names.every((name) => rule.deployments?.includes(name) === true) &&
    ruleMatchesBesidesDeployments(rule, finding)
  );
}

function ruleMatchesBesidesDeployments(
  rule: SuppressionRule,
  finding: Finding,
): boolean {
  // A behavioural finding is about no PRD scenario.
  if (rule.scenario !== undefined) {
    return false;
  }

  if (
    rule.boundary !== undefined &&
    !ruleBoundaryMatchesKey(rule.boundary, findingRuleBoundaryKey(finding))
  ) {
    return false;
  }
  return (
    mergedSideMatches(rule.consumer, finding, "consumer") &&
    mergedSideMatches(rule.provider, finding, "provider")
  );
}

/**
 * The key a rule's `boundary` gives for this binding. Storage has no
 * identity key, since its own pass pairs it, so a rule spells a store
 * the way that pass labels it, such as `postgresql:users`.
 */
export function ruleBoundaryKey(binding: BoundaryBinding): string | null {
  return boundaryKey(binding) ?? storageBoundaryKey(binding.semantics);
}

/**
 * The name a finding about one read is about, such as an environment
 * variable, or null for any other finding. Such a finding has the reader
 * on both sides and the name as the consumer's field. A column finding
 * between two declarations of a table has that too, so the boundary's
 * protocol has to say its findings are reads.
 */
export function readSiteField(finding: Finding): string | null {
  const { field, summary } = finding.consumer;
  if (
    !findingsAreReadsByName(finding.boundary) ||
    field === undefined ||
    summary !== finding.provider.summary
  ) {
    return null;
  }
  return field;
}

/**
 * The key a rule's `boundary` matches this finding at. A finding about
 * one read is at the boundary and the name read, as the report prints
 * it (`runtime-config STRIPE_API_KEY`), so a rule accepting it keeps
 * matching when the code that reads it moves to another file.
 */
export function findingRuleBoundaryKey(finding: Finding): string | null {
  const field = readSiteField(finding);
  if (field !== null) {
    return labelWithDetail(finding.boundary, field);
  }
  return ruleBoundaryKey(finding.boundary);
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
  return applySuppressionsToFindings(
    findings.map((f) => withoutAcceptedDeployments(f, rules)),
    rules,
    ruleMatchesFinding,
    opts,
  );
}

/**
 * A deployment named the way a finding about one read lists it, from the
 * summary in its `sources`: `cloudformation:template.yaml::Checkout` is
 * `Checkout`.
 */
export function deploymentName(source: string): string {
  return source.slice(source.lastIndexOf("::") + 2);
}

/** The deployments a finding about one read is against, or none for any other finding. */
export function findingDeployments(finding: Finding): string[] {
  if (readSiteField(finding) === null) {
    return [];
  }
  return (finding.sources ?? []).map(deploymentName);
}

/**
 * The finding with the deployments rules accept taken off its list, in
 * rule order. The rule that would take the last ones off is left for
 * the matching pass, which then suppresses the finding with that rule's
 * reason and effect.
 */
function withoutAcceptedDeployments(
  finding: Finding,
  rules: SuppressionRule[],
): Finding {
  let remaining = finding.sources ?? [];
  if (findingDeployments(finding).length === 0) {
    return finding;
  }

  for (const rule of rules) {
    const accepted = rule.deployments;
    if (
      accepted === undefined ||
      (rule.kind !== undefined && rule.kind !== finding.kind) ||
      !ruleMatchesBesidesDeployments(rule, finding)
    ) {
      continue;
    }

    const left = remaining.filter(
      (source) => !accepted.includes(deploymentName(source)),
    );
    if (left.length === 0) {
      break;
    }
    remaining = left;
  }
  return remaining.length === finding.sources?.length
    ? finding
    : { ...finding, sources: remaining };
}
