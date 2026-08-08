/**
 * The suppression pipeline, over the smallest finding both checkers share.
 *
 * Behavioural `Finding` and intent `IntentFinding` both have `kind`,
 * `severity`, and an optional `suppressed`, which is all the pipeline
 * needs. The rule schema, first-match-wins matching, effect application,
 * and threshold counting are here so the two checkers share one
 * implementation without depending on each other. Only the matching of a
 * rule's discriminators differs, and a caller passes that in.
 *
 * The module owns rules and matching, not file I/O. The CLI reads a
 * .sussignore file, checks each kind against the published enums, and
 * hands the parsed rules over.
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
     * The finding kind to match, behavioural or intent. It is an open
     * string here because this package is below both IRs, and the loader
     * is what validates it against the published kind enums.
     */
    kind: z.string().optional(),
    /**
     * Boundary as a human-readable key, e.g. "GET /pet/{petId}" or
     * "fn:@acme/api::getUser". REST keys are normalized via the same
     * path normalizer the checkers use, so `:id` and `{id}` compare
     * equal.
     */
    boundary: z.string().optional(),
    /**
     * Consumer-side discriminators, the narrowest useful match. These
     * mean something only for behavioural findings: a rule that
     * specifies `consumer` never matches an intent finding, because an
     * intent finding has no consumer side.
     */
    consumer: SuppressionSideSchema,
    /**
     * Provider-side discriminators, the mirror of `consumer`. A finding
     * about a status the provider produces has its transition id on this
     * side, and that id is the only handle narrow enough to pick out
     * that one finding. As with `consumer`, a rule that specifies
     * `provider` never matches an intent finding.
     */
    provider: SuppressionSideSchema,
    /**
     * "narrow", the default, requires kind plus one of boundary,
     * consumer.transitionId, or provider.transitionId, which is enough
     * to target a specific class of finding. "broad" opts in to
     * kind-only or boundary-only matches, which also silence future
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
 * The structural base that both finding types satisfy. Behavioural
 * `Finding` and intent `IntentFinding` each declare these fields in
 * their own schemas, kept structurally identical, and the pipeline needs
 * nothing more. The `| undefined` unions match what zod infers for
 * `.optional()` fields under exactOptionalPropertyTypes.
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
 * Check that a narrow rule constrains something. A bare rule with only
 * a `reason` would suppress every finding in the codebase, which is
 * almost always a mistake. Broad-scope rules are allowed to match less
 * specifically, on purpose.
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
 * Apply suppression rules to a list of findings. This works for either
 * finding type: `matches` decides whether a rule's discriminators past
 * `kind` (boundary, consumer, and so on) match a finding, and the kind
 * check itself is the same everywhere, so it happens here.
 *
 * Returns a new array. Findings with `effect: "hide"` are omitted from
 * the output entirely unless `keepHidden` is set. Findings with
 * `effect: "mark"` or `"downgrade"` are included with an added
 * `suppressed` field. First matching rule wins.
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
 * `hide` and `mark` findings are left out of the exit-code threshold,
 * and a `downgrade` finding counts at the severity it was downgraded
 * to. Callers use this to decide whether a finding contributes to
 * `hasErrors`-style gating.
 */
export function countsForThreshold(finding: SuppressibleFinding): boolean {
  if (finding.suppressed === undefined) {
    return true;
  }
  return finding.suppressed.effect === "downgrade";
}
