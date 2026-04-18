// suppressions.ts — match findings against .sussignore rules and apply effects.
//
// This module owns the rule shape and the match/apply logic. It does
// NOT load files — the CLI reads .sussignore.yml / .sussignore.json
// from disk and hands the parsed rules here. Keeping file I/O out of
// @suss/checker means the checker stays a pure boundary-analysis layer
// with no yaml/fs dependencies.
//
// Matching model: a finding is suppressed by the FIRST rule that
// matches. A rule matches when every specified field equals the
// finding's value on that field. Unspecified fields act as wildcards.
// "Broad" rules (kind-only or boundary-only) are allowed but require
// an explicit `scope: "broad"` on the rule to force the author to see
// what they're silencing — narrow is the default.

import { z } from "zod";

import { boundaryKey, normalizePath } from "./pairing.js";

import type { Finding, FindingSeverity } from "@suss/behavioral-ir";

// ---------------------------------------------------------------------------
// Rule schema
// ---------------------------------------------------------------------------

export const SuppressionRuleSchema = z
  .object({
    /** Finding kind to match. */
    kind: z
      .enum([
        "unhandledProviderCase",
        "deadConsumerBranch",
        "providerContractViolation",
        "consumerContractViolation",
        "lowConfidence",
      ])
      .optional(),
    /**
     * Boundary as a human-readable key, e.g. "GET /pet/{petId}". Case
     * and param-syntax are normalized via the same path normalizer the
     * checker uses, so `:id` and `{id}` compare equal.
     */
    boundary: z.string().optional(),
    /** Consumer-side discriminators (narrowest useful match). */
    consumer: z
      .object({
        summary: z.string().optional(),
        transitionId: z.string().optional(),
      })
      .optional(),
    /**
     * "narrow" (default): requires at least (kind + boundary) OR
     *   (kind + consumer.transitionId) — enough to target a specific
     *   finding class. "broad" opts in to kind-only or boundary-only
     *   matches, which silence future regressions in that category too.
     */
    scope: z.enum(["narrow", "broad"]).default("narrow"),
    /** Required human-written justification. */
    reason: z.string().min(1),
    /** What to do when a finding matches. */
    effect: z.enum(["mark", "downgrade", "hide"]).default("mark"),
  })
  .strict();

export type SuppressionRule = z.infer<typeof SuppressionRuleSchema>;

export const SuppressionFileSchema = z
  .object({
    version: z.literal(1),
    rules: z.array(SuppressionRuleSchema),
  })
  .strict();

export type SuppressionFile = z.infer<typeof SuppressionFileSchema>;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate that a narrow rule actually constrains *something* — a bare
 * rule with only `reason` would suppress every finding in the codebase,
 * which is almost always a mistake. Broad-scope rules deliberately
 * allow less-specific matching.
 */
export function validateRule(rule: SuppressionRule): string | null {
  if (rule.scope === "broad") {
    if (
      rule.kind === undefined &&
      rule.boundary === undefined &&
      rule.consumer === undefined
    ) {
      return "broad-scope rule must constrain at least one field (kind, boundary, or consumer)";
    }
    return null;
  }
  // narrow scope: require either (kind + boundary) or (kind + consumer.transitionId)
  const hasKind = rule.kind !== undefined;
  const hasBoundary = rule.boundary !== undefined;
  const hasConsumerTxn = rule.consumer?.transitionId !== undefined;
  if (hasKind && (hasBoundary || hasConsumerTxn)) {
    return null;
  }
  return "narrow-scope rule must specify kind AND (boundary OR consumer.transitionId); set scope: 'broad' to silence wider categories";
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

function ruleMatchesFinding(rule: SuppressionRule, finding: Finding): boolean {
  if (rule.kind !== undefined && rule.kind !== finding.kind) {
    return false;
  }
  if (rule.boundary !== undefined) {
    const findingKey = boundaryKey(finding.boundary);
    if (findingKey === null) {
      return false;
    }
    const ruleKey = normalizeRuleBoundary(rule.boundary);
    if (findingKey !== ruleKey) {
      return false;
    }
  }
  if (rule.consumer !== undefined) {
    if (
      rule.consumer.summary !== undefined &&
      rule.consumer.summary !== finding.consumer.summary
    ) {
      return false;
    }
    if (
      rule.consumer.transitionId !== undefined &&
      rule.consumer.transitionId !== finding.consumer.transitionId
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Normalize a rule's boundary string to match `boundaryKey`'s output
 * format. Authors may write "GET /pet/:id" or "GET /pet/{id}"; we
 * accept either. Method is uppercased; the path goes through
 * `normalizePath` (colon-to-brace, trailing-slash stripping, lowercase
 * static segments).
 */
function normalizeRuleBoundary(raw: string): string {
  const trimmed = raw.trim();
  const spaceIdx = trimmed.indexOf(" ");
  if (spaceIdx < 0) {
    return trimmed.toUpperCase(); // method only (unlikely but don't crash)
  }
  const method = trimmed.slice(0, spaceIdx).toUpperCase();
  const path = trimmed.slice(spaceIdx + 1);
  return `${method} ${normalizePath(path)}`;
}

// ---------------------------------------------------------------------------
// Effect application
// ---------------------------------------------------------------------------

const SEVERITY_DOWNGRADE: Record<FindingSeverity, FindingSeverity> = {
  error: "warning",
  warning: "info",
  info: "info",
};

function applyRuleToFinding(rule: SuppressionRule, finding: Finding): Finding {
  const common = {
    reason: rule.reason,
    effect: rule.effect,
  } as const;
  if (rule.effect === "downgrade") {
    return {
      ...finding,
      severity: SEVERITY_DOWNGRADE[finding.severity],
      suppressed: { ...common, originalSeverity: finding.severity },
    };
  }
  return { ...finding, suppressed: { ...common } };
}

/**
 * Apply suppression rules to a list of findings.
 *
 * Returns a new array. Findings with `effect: "hide"` are omitted from
 * the output entirely (their suppression is preserved only in the
 * debug channel via the optional `onSuppressed` callback). Findings
 * with `effect: "mark"` or `"downgrade"` are included with an added
 * `suppressed` field.
 *
 * Callers that want to render hidden findings (e.g. `suss check
 * --show-suppressed`) can pass `keepHidden: true` to keep them in the
 * output; the renderer is then responsible for filtering based on
 * `finding.suppressed.effect`.
 */
export function applySuppressions(
  findings: Finding[],
  rules: SuppressionRule[],
  opts: { keepHidden?: boolean } = {},
): Finding[] {
  const out: Finding[] = [];
  for (const f of findings) {
    const rule = rules.find((r) => ruleMatchesFinding(r, f));
    if (rule === undefined) {
      out.push(f);
      continue;
    }
    const applied = applyRuleToFinding(rule, f);
    if (applied.suppressed?.effect === "hide" && !opts.keepHidden) {
      continue;
    }
    out.push(applied);
  }
  return out;
}

/**
 * `hide` and `mark` findings are excluded from exit-code threshold
 * calculations; `downgrade` findings count at their post-downgrade
 * severity. Callers use this to decide whether a finding contributes
 * to `hasErrors`-style gating.
 */
export function countsForThreshold(finding: Finding): boolean {
  if (finding.suppressed === undefined) {
    return true;
  }
  return finding.suppressed.effect === "downgrade";
}
