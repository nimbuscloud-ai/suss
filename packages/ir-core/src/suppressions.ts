// suppressions.ts — the suppression pipeline over the shared finding base.
//
// Both finding shapes (behavioural `Finding`, intent `IntentFinding`)
// carry `kind` / `severity` / optional `suppressed`; that thin base is
// all the pipeline needs. The rule schema, first-match-wins semantics,
// effect application, and threshold counting live here so both
// checkers share one implementation without depending on each other.
// What differs per checker is only *how a rule's discriminators match
// a finding* (behavioural findings key their boundary from a binding
// and have a consumer side; intent findings carry the key directly) —
// callers supply that as a matcher.
//
// This module owns rules and matching, NOT file I/O — the CLI reads
// .sussignore.yml / .sussignore.json from disk and hands parsed rules
// here. It also can't enumerate valid finding kinds (those live in the
// IR packages above it), so `kind` is an open string; the CLI loader
// validates kinds against the published kind enums and rejects typos.

import { z } from "zod";

import { normalizePath } from "./boundaryKey.js";

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
     * Finding kind to match — any behavioural or intent finding kind.
     * Open here (this package sits below both IRs); the loader
     * validates against the published kind enums.
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
     * Consumer-side discriminators (narrowest useful match). Only
     * meaningful for behavioural findings — a rule that specifies
     * `consumer` never matches an intent finding, which has no
     * consumer side.
     */
    consumer: SuppressionSideSchema,
    /**
     * Provider-side discriminators, the mirror of `consumer`. A finding
     * about a status the provider produces carries its transition id on
     * this side, and that id is the only handle narrow enough to name
     * that one finding. Like `consumer`, a rule that specifies
     * `provider` never matches an intent finding.
     */
    provider: SuppressionSideSchema,
    /**
     * "narrow" (default): requires kind plus one of boundary,
     * consumer.transitionId, or provider.transitionId — enough to
     * target a specific finding class. "broad" opts in to kind-only or
     * boundary-only matches, which silence future regressions in that
     * category too.
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
 * The structural base both finding shapes satisfy. Behavioural
 * `Finding` and intent `IntentFinding` each declare these fields in
 * their own schemas (kept structurally identical); the pipeline needs
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

/**
 * Normalize a rule's boundary string to match `boundaryKey`'s output
 * format. Authors may write "GET /pet/:id" or "GET /pet/{id}"; we
 * accept either. Method is uppercased; the path goes through
 * `normalizePath` (colon-to-brace, trailing-slash stripping, lowercase
 * static segments). Non-REST keys ("fn:...", "gql:...") don't have the
 * METHOD-space-path shape and are compared verbatim by callers.
 */
export function normalizeRuleBoundary(raw: string): string {
  const trimmed = raw.trim();
  const spaceIdx = trimmed.indexOf(" ");
  if (spaceIdx < 0) {
    return trimmed; // no METHOD/path split — compare verbatim
  }
  const method = trimmed.slice(0, spaceIdx).toUpperCase();
  const path = trimmed.slice(spaceIdx + 1);
  return `${method} ${normalizePath(path)}`;
}

/**
 * Does a rule's `boundary` discriminator match a finding's boundary
 * key? Exact match first (covers "fn:...", "gql:..."), then the
 * REST-normalized form.
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
  // The casts are sound for any T whose severity / suppressed fields
  // are the full base unions (true of both finding shapes); TS can't
  // prove it for arbitrary narrowings of T.
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
 * Apply suppression rules to a list of findings. Generic over the
 * finding shape: `matches` decides whether a rule's discriminators
 * beyond `kind` (boundary, consumer, ...) match a finding — the kind
 * check itself is universal and handled here.
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
 * `hide` and `mark` findings are excluded from exit-code threshold
 * calculations; `downgrade` findings count at their post-downgrade
 * severity. Callers use this to decide whether a finding contributes
 * to `hasErrors`-style gating.
 */
export function countsForThreshold(finding: SuppressibleFinding): boolean {
  if (finding.suppressed === undefined) {
    return true;
  }
  return finding.suppressed.effect === "downgrade";
}
