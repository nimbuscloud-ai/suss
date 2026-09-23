/**
 * @suss/intent-ir: the side of the comparison the team writes.
 *
 * There are two kinds of document, both built on @suss/ir-core so
 * intent and behavior describe boundaries the same way:
 *   - System intent (kind: boundary): what one boundary should do.
 *   - Outcome intent (kind: prd): human scenarios that can link to
 *     system-intent outcomes.
 *
 * `IntentDoc` is what an author writes, and `IntentSummary` is the
 * normalized form the checker reads. Readers such as
 * @suss/contract-intent parse files into an `IntentDoc` and call
 * `intentDocToSummary`.
 */

export {
  IntentFindingKindSchema,
  IntentFindingSchema,
  IntentFindingSeveritySchema,
  IntentFindingSuppressionSchema,
  IntentRefSchema,
} from "./findings.js";
export {
  ACCEPTS_NULL,
  BodyShapeSchema,
  BoundarySchema,
  blanksLeftEmpty,
  fillBlanks,
  IntentDocSchema,
  IntentSourceSchema,
} from "./schema.js";
export {
  intentDocToSummary,
  toBoundaryBinding,
  toReceives,
} from "./summary.js";

export type {
  IntentFinding,
  IntentFindingKind,
  IntentFindingSeverity,
  IntentFindingSuppression,
  IntentRef,
} from "./findings.js";
export type {
  AuthoredBoundary,
  AuthoredInputField,
  AuthoredReceives,
  AuthoredRestReceives,
  AuthoredShape,
  BodyShape,
  Boundary,
  BoundaryIntent,
  BoundaryTransition,
  EffectOutcome,
  IntentDoc,
  IntentSource,
  Prd,
  PrdScenario,
  PrimitiveTypeName,
  When,
  WhenClause,
} from "./schema.js";
export type {
  BoundaryIntentSummary,
  IntentCondition,
  IntentEffect,
  IntentInputField,
  IntentOutcome,
  IntentOutcomeKind,
  IntentSummary,
  PrdScenarioSummary,
  PrdSummary,
} from "./summary.js";
