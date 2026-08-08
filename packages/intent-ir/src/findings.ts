// @suss/intent-ir findings: the result shape the intent checker emits.
//
// Symmetric with @suss/behavioral-ir's `Finding`, but deliberately NOT
// the same shape. A behavioral Finding is a two-sided peer comparison
// (provider ↔ consumer, each with a source location). An intent finding
// is one-sided coverage: "the team declared X; does the code satisfy
// it?" Intent has a name and an outcome id, not a file + range, so it
// gets fields that fit, and PRD scenario / link findings extend this
// base rather than forcing intent into the peer shape.

import { z } from "zod";

export const IntentFindingKindSchema = z.enum([
  // System intent (kind: boundary) vs code:
  "uncoveredOutcome", // intent declares an outcome the code never produces
  "unimplementedBoundary", // intent boundary has no implementing code at all
  "outcomeShapeMismatch", // a matched outcome whose body shapes disagree
  "undeclaredOutcome", // code produces a REST status the intent doesn't declare
  "unkeyableBoundary", // intent boundary can't be keyed, so it can't be checked
  // Outcome intent (kind: prd), scenario link coverage against system
  // intent. These concretise the proposal's "scenario not linked /
  // dangling / ambiguous" set (docs/internal/proposals/intent-specs.md);
  // the proposal deferred concrete names to implementation time.
  "unlinkedScenario", // scenario carries no structured link (info — a valid pending state)
  "danglingScenarioLink", // link names an intent / outcome no boundary intent declares
  "ambiguousScenarioLink", // link resolves to two or more boundary intents sharing the name
]);
export type IntentFindingKind = z.infer<typeof IntentFindingKindSchema>;

export const IntentFindingSeveritySchema = z.enum(["error", "warning", "info"]);
export type IntentFindingSeverity = z.infer<typeof IntentFindingSeveritySchema>;

/** Which intent (and, when relevant, which outcome) a finding concerns. */
export const IntentRefSchema = z.object({
  /** The intent doc's `name` (boundary) or `title` (prd). */
  name: z.string(),
  /** The declared outcome id, when the finding is outcome-specific. */
  outcomeId: z.string().optional(),
});
export type IntentRef = z.infer<typeof IntentRefSchema>;

/**
 * Suppression annotation stamped by the .sussignore pipeline. Kept
 * structurally identical to the behavioural `Finding.suppressed` shape
 * so @suss/ir-core's shared suppression pipeline operates on both.
 */
export const IntentFindingSuppressionSchema = z.object({
  /** The rule's human-written justification. */
  reason: z.string(),
  effect: z.enum(["mark", "downgrade", "hide"]),
  /** Original severity, present only when effect is "downgrade". */
  originalSeverity: IntentFindingSeveritySchema.optional(),
});
export type IntentFindingSuppression = z.infer<
  typeof IntentFindingSuppressionSchema
>;

export const IntentFindingSchema = z.object({
  kind: IntentFindingKindSchema,
  severity: IntentFindingSeveritySchema,
  /**
   * Human-readable boundary label: e.g. `GET /users/:id` or
   * `fn:@suss/cli::contract`. The key the intent and code were paired on.
   */
  boundary: z.string(),
  /** The intent side of the finding. */
  intent: IntentRefSchema,
  /**
   * The matched code summary as `${file}::${name}`, when the finding
   * concerns a specific implementation. Absent for unimplementedBoundary.
   */
  code: z.string().optional(),
  /**
   * PRD-scenario extension: present only on outcome-intent findings
   * (unlinkedScenario / danglingScenarioLink / ambiguousScenarioLink).
   * Identifies the scenario (by its optional title) and the qualified
   * outcome ref (`<intent-name>.<outcome-id>`) that failed to resolve.
   * The peer / boundary findings leave it unset. This is the "intent
   * finding extension" decision 2 of the proposal anticipated.
   */
  scenario: z
    .object({
      title: z.string().optional(),
      link: z.string().optional(),
    })
    .optional(),
  message: z.string(),
  /** Present when a .sussignore rule matched this finding. */
  suppressed: IntentFindingSuppressionSchema.optional(),
});
export type IntentFinding = z.infer<typeof IntentFindingSchema>;
