// @suss/intent-ir: the team-authored side of the loop.
//
// Two citizens, both built on @suss/ir-core primitives so intent and
// behaviour describe boundaries the same way and can be compared:
//
//   - System intent (kind: boundary), what a boundary should do.
//   - Outcome intent (kind: prd), human scenarios that link to
//                                       system-intent outcomes.
//
// `schema.ts` is the authoring surface; `summary.ts` is the normalised
// shape the checker consumes plus the transform between them. Readers
// (e.g. @suss/contract-intent) parse files into IntentDoc and call
// `intentDocToSummary`.

export {
  IntentFindingKindSchema,
  IntentFindingSchema,
  IntentFindingSeveritySchema,
  IntentFindingSuppressionSchema,
  IntentRefSchema,
} from "./findings.js";
export {
  BodyShapeSchema,
  BoundarySchema,
  blanksLeftEmpty,
  IntentDocSchema,
  IntentSourceSchema,
} from "./schema.js";
export { intentDocToSummary, toBoundaryBinding } from "./summary.js";

export type {
  IntentFinding,
  IntentFindingKind,
  IntentFindingSeverity,
  IntentFindingSuppression,
  IntentRef,
} from "./findings.js";
export type {
  AuthoredBoundary,
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
  IntentOutcome,
  IntentOutcomeKind,
  IntentSummary,
  PrdScenarioSummary,
  PrdSummary,
} from "./summary.js";
