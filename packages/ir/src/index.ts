// @suss/behavioral-ir — core types, schemas, and utilities for the
// behavioral summary format.
//
// Schemas in `./schemas` are the single source of truth. Types here are
// derived via `z.infer` so there is nothing to keep in sync by hand.
// Schemas themselves are not part of the public API — consumers get the
// types plus `parseSummary`/`parseSummaries` for runtime validation.
// Anyone needing zod-level composition can import the schema module
// directly via the package's internal path; that surface is not stable.

import {
  BehavioralSummaryArraySchema,
  BehavioralSummarySchema,
  type BoundaryBindingSchema,
  type CodeUnitIdentitySchema,
  type CodeUnitKindSchema,
  type ComparisonOpSchema,
  type ConfidenceInfoSchema,
  type DerivationSchema,
  type EffectSchema,
  type FindingKindSchema,
  type FindingSchema,
  type FindingSeveritySchema,
  type FindingSideSchema,
  type GapSchema,
  type InputSchema,
  type LiteralSchema,
  type OpaqueReasonSchema,
  type OutputSchema,
  type PredicateSchema,
  type RenderNodeSchema,
  type SourceLocationSchema,
  type SummaryDiffSchema,
  type TransitionSchema,
  type TypeShapeSchema,
  type ValueRefSchema,
} from "./schemas.js";

import type { z } from "zod";

// ---------------------------------------------------------------------------
// Derived types (single source of truth: schemas.ts)
// ---------------------------------------------------------------------------

export type CodeUnitKind = z.infer<typeof CodeUnitKindSchema>;
export type ComparisonOp = z.infer<typeof ComparisonOpSchema>;
export type OpaqueReason = z.infer<typeof OpaqueReasonSchema>;
export type FindingKind = z.infer<typeof FindingKindSchema>;
export type FindingSeverity = z.infer<typeof FindingSeveritySchema>;

export type SourceLocation = z.infer<typeof SourceLocationSchema>;
export type BoundaryBinding = z.infer<typeof BoundaryBindingSchema>;
export type CodeUnitIdentity = z.infer<typeof CodeUnitIdentitySchema>;
export type ConfidenceInfo = z.infer<typeof ConfidenceInfoSchema>;

export type Literal = z.infer<typeof LiteralSchema>;
export type Derivation = z.infer<typeof DerivationSchema>;
export type ValueRef = z.infer<typeof ValueRefSchema>;
export type Predicate = z.infer<typeof PredicateSchema>;
export type TypeShape = z.infer<typeof TypeShapeSchema>;

export type Input = z.infer<typeof InputSchema>;
export type Output = z.infer<typeof OutputSchema>;
export type Effect = z.infer<typeof EffectSchema>;
export type RenderNode = z.infer<typeof RenderNodeSchema>;

export type Transition = z.infer<typeof TransitionSchema>;
export type Gap = z.infer<typeof GapSchema>;
export type BehavioralSummary = z.infer<typeof BehavioralSummarySchema>;
export type SummaryDiff = z.infer<typeof SummaryDiffSchema>;

export type FindingSide = z.infer<typeof FindingSideSchema>;
export type Finding = z.infer<typeof FindingSchema>;

// ---------------------------------------------------------------------------
// Boundary role (provider vs consumer)
// ---------------------------------------------------------------------------

/**
 * The role a code unit plays at a boundary. Pairing logic looks this up
 * via `BOUNDARY_ROLE` so adding a new kind requires only a single edit
 * (and the lookup becomes a type error if a variant is missed).
 */
export type BoundaryRole = "provider" | "consumer";

export const BOUNDARY_ROLE: Record<CodeUnitKind, BoundaryRole> = {
  handler: "provider",
  loader: "provider",
  action: "provider",
  middleware: "provider",
  resolver: "provider",
  worker: "provider",
  component: "provider",
  hook: "provider",
  client: "consumer",
  consumer: "consumer",
};

// ---------------------------------------------------------------------------
// Parsing entry points
// ---------------------------------------------------------------------------

/**
 * Validate and return a single summary, throwing on failure. Use this at
 * boundaries where invalid data should halt processing (CLI loading from
 * disk).
 */
export function parseSummary(input: unknown): BehavioralSummary {
  return BehavioralSummarySchema.parse(input);
}

export function safeParseSummary(
  input: unknown,
): z.ZodSafeParseResult<BehavioralSummary> {
  return BehavioralSummarySchema.safeParse(input);
}

/**
 * Validate and return an array of summaries. Throws if the input is not
 * an array, or any element fails validation. Use `safeParseSummaries`
 * for non-throwing behavior.
 */
export function parseSummaries(input: unknown): BehavioralSummary[] {
  return BehavioralSummaryArraySchema.parse(input);
}

export function safeParseSummaries(
  input: unknown,
): z.ZodSafeParseResult<BehavioralSummary[]> {
  return BehavioralSummaryArraySchema.safeParse(input);
}

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

export function diffSummaries(
  before: BehavioralSummary,
  after: BehavioralSummary,
): SummaryDiff {
  const beforeById = new Map(before.transitions.map((t) => [t.id, t]));
  const afterById = new Map(after.transitions.map((t) => [t.id, t]));

  const addedTransitions: Transition[] = [];
  const removedTransitions: Transition[] = [];
  const changedTransitions: Array<{ before: Transition; after: Transition }> =
    [];

  for (const [id, afterT] of afterById) {
    if (!beforeById.has(id)) {
      addedTransitions.push(afterT);
    }
  }

  for (const [id, beforeT] of beforeById) {
    const afterT = afterById.get(id);
    if (!afterT) {
      removedTransitions.push(beforeT);
    } else if (JSON.stringify(beforeT) !== JSON.stringify(afterT)) {
      changedTransitions.push({ before: beforeT, after: afterT });
    }
  }

  return { addedTransitions, removedTransitions, changedTransitions };
}
