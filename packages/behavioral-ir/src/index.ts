// @suss/behavioral-ir — core types, schemas, and utilities for the
// behavioral summary format.
//
// Schemas in `./schemas` are the single source of truth. Types here are
// derived via `z.infer` so there is nothing to keep in sync by hand.
// Schemas themselves are not part of the public API — consumers get the
// types plus `parseSummary`/`parseSummaries` for runtime validation.
// Anyone needing zod-level composition can import the schema module
// directly via the package's internal path; that surface is not stable.

import { normalizeLegacySummary } from "./legacy.js";
import {
  BehavioralSummaryArraySchema,
  BehavioralSummarySchema,
  type BoundaryAspectSchema,
  type CodeUnitIdentitySchema,
  type CodeUnitKindSchema,
  type ComparisonOpSchema,
  type DerivationSchema,
  type EffectSchema,
  FindingKindSchema,
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
  type SummaryDiffSchema,
  type TransitionSchema,
  type ValueRefSchema,
} from "./schemas.js";

import type { z } from "zod";

// Shared IR primitives live in @suss/ir-core. Re-export the types and the
// binding constructors so existing `@suss/behavioral-ir` consumers reach
// them unchanged; behaviour-specific types are derived from schemas.ts below.
export {
  type DispatchTable,
  dispatchByType,
  functionCallBinding,
  graphqlOperationBinding,
  graphqlResolverBinding,
  messageBusBinding,
  packageExportBinding,
  restBinding,
  runtimeConfigBinding,
  storageRelationalBinding,
} from "@suss/ir-core";

export { normalizeLegacySummary, SUMMARY_SCHEMA_VERSION } from "./legacy.js";
export {
  type EnvVarSource,
  type MessageBusMetadata,
  MessageBusMetadataSchema,
  type RuntimeContractMetadata,
  RuntimeContractMetadataSchema,
  readMessageBusMetadata,
  readRuntimeContractMetadata,
  withMessageBusMetadata,
  withRuntimeContractMetadata,
} from "./metadata.js";

export type {
  BoundaryBinding,
  ConfidenceInfo,
  ConfidenceLevel,
  ConfidenceSource,
  Corroboration,
  DeployableUnit,
  FunctionCallSemantics,
  GraphqlOperationSemantics,
  GraphqlResolverSemantics,
  MessageBusSemantics,
  RestSemantics,
  RuntimeConfigSemantics,
  Semantics,
  SourceLocation,
  StorageRelationalSemantics,
  TypeShape,
} from "@suss/ir-core";

// ---------------------------------------------------------------------------
// Derived types (single source of truth: schemas.ts)
// ---------------------------------------------------------------------------

export type CodeUnitKind = z.infer<typeof CodeUnitKindSchema>;
export type ComparisonOp = z.infer<typeof ComparisonOpSchema>;
export type OpaqueReason = z.infer<typeof OpaqueReasonSchema>;
export type FindingKind = z.infer<typeof FindingKindSchema>;

/**
 * Every behavioural finding kind, as runtime values. For consumers
 * that validate user-supplied kind references (e.g. .sussignore rules)
 * without reaching into the schema module, which is not public API.
 */
export const FINDING_KINDS: readonly FindingKind[] = FindingKindSchema.options;
export type FindingSeverity = z.infer<typeof FindingSeveritySchema>;
export type BoundaryAspect = z.infer<typeof BoundaryAspectSchema>;

export type CodeUnitIdentity = z.infer<typeof CodeUnitIdentitySchema>;

export type Literal = z.infer<typeof LiteralSchema>;
export type Derivation = z.infer<typeof DerivationSchema>;
export type ValueRef = z.infer<typeof ValueRefSchema>;
export type Predicate = z.infer<typeof PredicateSchema>;

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
// Naming a summary
// ---------------------------------------------------------------------------

/**
 * Name a summary the way a finding refers to it.
 *
 * The string this returns is read back as well as printed: the checker
 * deduplicates findings by it, and a `.sussignore` rule matches against
 * it. Both sides therefore have to agree on the separator and on which
 * two fields go into it, which is why one function owns the format
 * rather than each caller writing the template literal out.
 */
export function summaryRef(summary: BehavioralSummary): string {
  return `${summary.location.file}::${summary.identity.name}`;
}

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
  library: "provider",
  client: "consumer",
  consumer: "consumer",
  caller: "consumer",
  "module-init": "consumer",
};

// ---------------------------------------------------------------------------
// Parsing entry points
// ---------------------------------------------------------------------------

/**
 * Validate and return a single summary, throwing on failure. Use this at
 * boundaries where invalid data should halt processing (CLI loading from
 * disk). Version-1 artifacts are normalized first, so summaries written
 * by 0.3.x keep parsing.
 */
export function parseSummary(input: unknown): BehavioralSummary {
  return BehavioralSummarySchema.parse(normalizeLegacySummary(input));
}

export function safeParseSummary(
  input: unknown,
): z.ZodSafeParseResult<BehavioralSummary> {
  return BehavioralSummarySchema.safeParse(normalizeLegacySummary(input));
}

/**
 * Validate and return an array of summaries. Throws if the input is not
 * an array, or any element fails validation. Use `safeParseSummaries`
 * for non-throwing behavior.
 */
export function parseSummaries(input: unknown): BehavioralSummary[] {
  return BehavioralSummaryArraySchema.parse(normalizeLegacyArray(input));
}

export function safeParseSummaries(
  input: unknown,
): z.ZodSafeParseResult<BehavioralSummary[]> {
  return BehavioralSummaryArraySchema.safeParse(normalizeLegacyArray(input));
}

function normalizeLegacyArray(input: unknown): unknown {
  return Array.isArray(input) ? input.map(normalizeLegacySummary) : input;
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

// ---------------------------------------------------------------------------
// Predicate interpretation
// ---------------------------------------------------------------------------

export {
  type EvalValue,
  evalConditions,
  evalPredicate,
  evalValueRef,
  type InterpretEnv,
  type Tri,
  triAnd,
  triOr,
} from "./interpret.js";
