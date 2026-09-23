/**
 * The findings the intent checker emits.
 *
 * A behavioral `Finding` compares two peers, a provider and a consumer,
 * each with a source location. An intent finding checks coverage from
 * one side: the team declared something, and the question is whether
 * the code does it. Intent is identified by a name and an outcome id,
 * with no file or range, so an intent finding has its own fields, and
 * PRD scenario findings add to them.
 */

import { z } from "zod";

export const IntentFindingKindSchema = z.enum([
  // System intent (kind: boundary) vs code:
  "uncoveredOutcome", // intent declares an outcome the code never produces
  "unimplementedBoundary", // intent boundary has no implementing code at all
  "outcomeShapeMismatch", // a matched outcome whose body shapes disagree
  "undeclaredOutcome", // code produces a REST status the intent doesn't declare
  "unkeyableBoundary", // intent boundary can't be keyed, so it can't be checked
  "renamedBoundary", // a declared store vanished and an undeclared one of the same system appeared with the same outcomes
  // What the boundary is handed: the `receives` block against the paths
  // the unit reads off its input.
  "unreadInputField", // intent declares a field no transition of the unit reads
  "undeclaredInputRead", // the unit reads a path the receives block does not list
  // Outcome intent (kind: prd): whether each scenario's link resolves to
  // a system-intent outcome.
  "unlinkedScenario", // scenario has no structured link (info: a valid pending state)
  "danglingScenarioLink", // link names an intent / outcome no boundary intent declares
  "ambiguousScenarioLink", // link resolves to two or more boundary intents sharing the name
  // The same coverage question asked the other way: which declared
  // behaviour has nobody written a reason for.
  "undescribedOutcome", // a declared outcome no PRD scenario links to (info)
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
 * The annotation the `.sussignore` pipeline adds to a matched finding.
 * It stays structurally identical to the behavioral
 * `Finding.suppressed`, so @suss/ir-core's shared suppression pipeline
 * works on both.
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
   * Present only on outcome-intent findings (unlinkedScenario,
   * danglingScenarioLink, ambiguousScenarioLink). It gives the scenario,
   * by its optional title, and the qualified outcome ref
   * (`<intent-name>.<outcome-id>`) that failed to resolve. Boundary
   * findings leave it unset.
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
