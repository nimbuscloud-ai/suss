/**
 * Suppression rules and how they apply to findings from either checker.
 *
 * Behavioral `Finding` and intent `IntentFinding` both have `kind`,
 * `severity` and an optional `suppressed`, and the pipeline needs
 * nothing else. The rule schema, first-match-wins matching, effect
 * application and threshold counting are here so the two checkers share
 * one implementation without depending on each other. Each checker
 * passes in its own matcher for a rule's discriminators past `kind`.
 *
 * The CLI reads the `.sussignore` file, checks each kind against the
 * published enums, and passes the parsed rules in.
 */

import { z } from "zod";

import { normalizeRuleBoundary } from "./boundaryKey.js";

// ---------------------------------------------------------------------------
// Rule schema
// ---------------------------------------------------------------------------

/** The discriminators available on either side of a finding. */
const SuppressionSideSchema = z
  .object({
    summary: z.string().optional(),
    transitionId: z.string().optional(),
  })
  .optional();

export const SuppressionRuleSchema = z
  .object({
    /**
     * The finding kind to match, behavioral or intent. The schema accepts
     * any string because ir-core cannot import either IR's kind enum. The
     * CLI's loader checks it against both.
     */
    kind: z.string().optional(),
    /**
     * The boundary's human-readable key, such as "GET /pet/{petId}" or
     * "fn:@acme/api::getUser". A REST key goes through the same path
     * normalizer the checkers use, so `:id` and `{id}` compare equal.
     */
    boundary: z.string().optional(),
    /**
     * Consumer-side discriminators, the narrowest useful match. They
     * apply only to behavioral findings. A rule that sets `consumer`
     * never matches an intent finding, because an intent finding has no
     * consumer side.
     */
    consumer: SuppressionSideSchema,
    /**
     * Provider-side discriminators, matching the same fields as
     * `consumer`. A finding about a status the provider produces has its
     * transition id on this side, and that id is the only value narrow
     * enough to pick out that one finding. As with `consumer`, a rule
     * that sets `provider` never matches an intent finding.
     */
    provider: SuppressionSideSchema,
    /**
     * "narrow", the default, requires `kind` plus one of `boundary`,
     * `consumer.transitionId` or `provider.transitionId`, so the rule
     * targets a specific class of finding. "broad" allows a match on
     * kind alone or boundary alone, and such a rule also silences future
     * regressions in that category.
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
// The shared finding base the pipeline operates on
// ---------------------------------------------------------------------------

export type SuppressableSeverity = "error" | "warning" | "info";

/** The `suppressed` annotation stamped onto a matched finding. */
export interface FindingSuppression {
  reason: string;
  effect: "mark" | "downgrade" | "hide";
  /** Original severity, present only when effect is "downgrade". */
  originalSeverity?: SuppressableSeverity | undefined;
}

/**
 * The fields both finding types share. Behavioral `Finding` and intent
 * `IntentFinding` each declare these fields in their own schemas, and
 * the two declarations have to stay structurally identical. The
 * `| undefined` unions match what zod infers for `.optional()` fields
 * under exactOptionalPropertyTypes.
 */
export interface SuppressibleFinding {
  kind: string;
  severity: SuppressableSeverity;
  suppressed?: FindingSuppression | undefined;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * An error message when a rule does not constrain enough, or null when
 * it is valid. A rule with only a `reason` would suppress every finding
 * in the codebase, which is almost always a mistake. A broad rule needs
 * one constraint of any kind, and a narrow rule needs `kind` plus a
 * boundary or transition id.
 */
export function validateRule(rule: SuppressionRule): string | null {
  if (rule.scope === "broad") {
    if (
      rule.kind === undefined &&
      rule.boundary === undefined &&
      rule.consumer === undefined &&
      rule.provider === undefined
    ) {
      return "broad-scope rule must constrain at least one field (kind, boundary, consumer, or provider)";
    }
    return null;
  }
  const hasKind = rule.kind !== undefined;
  const hasBoundary = rule.boundary !== undefined;
  const hasTransition =
    rule.consumer?.transitionId !== undefined ||
    rule.provider?.transitionId !== undefined;
  if (hasKind && (hasBoundary || hasTransition)) {
    return null;
  }
  return "narrow-scope rule must specify kind AND (boundary OR consumer.transitionId OR provider.transitionId); set scope: 'broad' to silence wider categories";
}

// ---------------------------------------------------------------------------
// Matching helpers
// ---------------------------------------------------------------------------

export { normalizeRuleBoundary } from "./boundaryKey.js";

/**
 * Whether a rule's `boundary` discriminator matches a finding's boundary
 * key. It tries an exact match first, which covers "fn:..." and
 * "gql:...", and then the REST-normalized form.
 */
export function ruleBoundaryMatchesKey(
  ruleBoundary: string,
  key: string | null,
): boolean {
  if (key === null) {
    return false;
  }
  return ruleBoundary === key || normalizeRuleBoundary(ruleBoundary) === key;
}

// ---------------------------------------------------------------------------
// Effect application
// ---------------------------------------------------------------------------

const SEVERITY_DOWNGRADE: Record<SuppressableSeverity, SuppressableSeverity> = {
  error: "warning",
  warning: "info",
  info: "info",
};

function applyRuleToFinding<T extends SuppressibleFinding>(
  rule: SuppressionRule,
  finding: T,
): T {
  const common = {
    reason: rule.reason,
    effect: rule.effect,
  } as const;
  // The casts are safe for any T whose severity and suppressed fields
  // are the full base unions, which both finding types are. TypeScript
  // cannot prove that for an arbitrary narrowing of T.
  if (rule.effect === "downgrade") {
    return {
      ...finding,
      severity: SEVERITY_DOWNGRADE[finding.severity],
      suppressed: { ...common, originalSeverity: finding.severity },
    } as T;
  }
  return { ...finding, suppressed: { ...common } } as T;
}

/**
 * Apply suppression rules to a list of findings of either type. This
 * function checks `kind`, and `matches` checks the rest of a rule's
 * discriminators (boundary, consumer, and so on) against a finding.
 *
 * Returns a new array. The first matching rule applies. A finding a
 * `hide` rule matches is left out unless `keepHidden` is set. A finding
 * a `mark` or `downgrade` rule matches is kept with a `suppressed` field
 * added.
 */
export function applySuppressionsToFindings<T extends SuppressibleFinding>(
  findings: T[],
  rules: SuppressionRule[],
  matches: (rule: SuppressionRule, finding: T) => boolean,
  opts: { keepHidden?: boolean } = {},
): T[] {
  const out: T[] = [];
  for (const f of findings) {
    const rule = rules.find(
      (r) => (r.kind === undefined || r.kind === f.kind) && matches(r, f),
    );
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
 * Whether a finding counts toward the exit-code threshold. A `hide` or
 * `mark` finding does not count, and a `downgrade` finding counts at the
 * severity it was downgraded to.
 */
export function countsForThreshold(finding: SuppressibleFinding): boolean {
  if (finding.suppressed === undefined) {
    return true;
  }
  return finding.suppressed.effect === "downgrade";
}
