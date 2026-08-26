/**
 * @suss/behavioral-ir: the types, schemas, and helpers for the
 * behavioral summary format.
 *
 * The schemas in `./schemas` are the source of truth. The types here
 * come from them through `z.infer`, so there is nothing to keep in sync
 * by hand. The schemas themselves are not public API. What a consumer
 * gets is the types, plus `parseSummary` and `parseSummaries` for
 * validating at runtime. If you need to compose at the zod level you
 * can import the schema module by its internal path, but nothing
 * promises that path will keep working.
 */

import { normalizeLegacyArray, normalizeLegacySummary } from "./legacy.js";
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
  RunFindingKindSchema,
  type RunFindingSchema,
  type SummaryDiffSchema,
  type TransitionSchema,
  type ValueRefSchema,
} from "./schemas.js";
import { disambiguateSummaryIds } from "./summaryId.js";

import type { z } from "zod";

// Shared IR primitives live in @suss/ir-core. Re-export the types and the
// binding constructors so existing `@suss/behavioral-ir` consumers reach
// them unchanged; behaviour-specific types are derived from schemas.ts below.
export {
  type BoundaryName,
  boundaryKey,
  boundaryLabel,
  boundaryNameString,
  type DispatchTable,
  dispatchByType,
  displayLabel,
  exchangesHttpResponses,
  fixedTextLength,
  formatChannel,
  functionCallBinding,
  graphqlOperationBinding,
  graphqlResolverBinding,
  hasNameHole,
  isGraphqlOperationBinding,
  messageBusBinding,
  metricBinding,
  type NamePart,
  namePatternFromSub,
  namePatternKey,
  namesAgree,
  namesNothing,
  packageExportBinding,
  parseBoundaryName,
  patternHole,
  type Reference,
  referenceFromName,
  referenceName,
  referenceOf,
  restBinding,
  runtimeConfigBinding,
  semconvAttributes,
  storageBinding,
} from "@suss/ir-core";

export { normalizeLegacySummary, SUMMARY_SCHEMA_VERSION } from "./legacy.js";
export {
  type CodeScopeMetadata,
  type EnvVarSource,
  type GraphqlContractProvenance,
  type GraphqlDeclaredContract,
  type GraphqlMetadata,
  GraphqlMetadataSchema,
  type HttpContractProvenance,
  type HttpDeclaredContract,
  type HttpMetadata,
  HttpMetadataSchema,
  type LibraryEnvReads,
  type MessageBusMetadata,
  MessageBusMetadataSchema,
  type MetricAccumulation,
  MetricAccumulationSchema,
  type MetricContractMetadata,
  type MetricReadingMetadata,
  type MetricValueShape,
  MetricValueShapeSchema,
  type ReactMetadata,
  type RoutingMetadata,
  RoutingMetadataSchema,
  type RuntimeContractMetadata,
  RuntimeContractMetadataSchema,
  readCodeScopeMetadata,
  readGraphqlMetadata,
  readHttpMetadata,
  readLibraryEnvReads,
  readMessageBusMetadata,
  readMetricContractMetadata,
  readMetricReadingMetadata,
  readModuleImports,
  readReactMetadata,
  readRoutingMetadata,
  readRuntimeContractMetadata,
  readSourceDocumentMetadata,
  readStorageContractMetadata,
  readStorybookMetadata,
  type SourceDocumentMetadata,
  SourceDocumentMetadataSchema,
  type StorageContractMetadata,
  type StorybookMetadata,
  withGraphqlMetadata,
  withHttpMetadata,
  withMessageBusMetadata,
  withRoutingMetadata,
  withRuntimeContractMetadata,
  withSourceDocumentMetadata,
} from "./metadata.js";
export {
  type DocumentLabelParts,
  type FlowRequest,
  namesDocumentByFileName,
  nestedDocumentLabel,
  parseDocumentLabel,
  type RouterMatchSelector,
  type RouterSelection,
  type RoutingMatchCondition,
  type RoutingMatchRecord,
  rootDocumentLabel,
} from "./routing.js";
export {
  disambiguateSummaryIds,
  type SummaryIdParts,
  summaryIdentifier,
  summaryIdFromParts,
} from "./summaryId.js";

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
  MessageBusTechnology,
  MetricSemantics,
  RestSemantics,
  RuntimeConfigSemantics,
  Semantics,
  SourceLocation,
  StorageSemantics,
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
export type RunFindingKind = z.infer<typeof RunFindingKindSchema>;
export type RunFinding = z.infer<typeof RunFindingSchema>;

/** Every run-level finding kind, as runtime values. See FINDING_KINDS. */
export const RUN_FINDING_KINDS: readonly RunFindingKind[] =
  RunFindingKindSchema.options;
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
 * Refer to a summary the way a finding does.
 *
 * The string that comes back gets read as well as printed: the checker
 * deduplicates findings by it, and a `.sussignore` rule matches against
 * it. Both sides have to agree on the separator and on which two fields
 * go into it, so one function owns the format instead of every caller
 * writing out the template literal.
 *
 * It is file-and-name rather than `identity.id` on purpose: a rule
 * someone already wrote has to keep matching, and an id includes the
 * workspace, which changes the string for most projects. Code following
 * a link instead of printing one has `identity.id` and `effect.summary`.
 */
declare const SummaryRefBrand: unique symbol;

/** The `file::name` reference, with `summaryRef` its only constructor. */
export type SummaryRef = string & { readonly [SummaryRefBrand]: "summaryRef" };

export function summaryRef(summary: BehavioralSummary): SummaryRef {
  return `${summary.location.file}::${summary.identity.name}` as SummaryRef;
}

// ---------------------------------------------------------------------------
// Catch entry
// ---------------------------------------------------------------------------

/**
 * The source text a path engine writes on the condition that says a
 * branch was reached by an exception. It is the same in every language
 * so transition IDs stay stable, and `isCatchEntry` is how a check asks
 * without spelling the string a second time.
 */
export const CATCH_ENTRY_TEXT = "catch";

/** Whether this condition says the branch was reached by an exception. */
export function isCatchEntry(predicate: Predicate): boolean {
  return (
    predicate.type === "opaque" && predicate.sourceText === CATCH_ENTRY_TEXT
  );
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
  const { value, anyIdBackfilled } = normalizeLegacyArray(input);
  const parsed = BehavioralSummaryArraySchema.parse(value);
  if (anyIdBackfilled) {
    disambiguateSummaryIds(parsed);
  }
  return parsed;
}

export function safeParseSummaries(
  input: unknown,
): z.ZodSafeParseResult<BehavioralSummary[]> {
  const { value, anyIdBackfilled } = normalizeLegacyArray(input);
  const result = BehavioralSummaryArraySchema.safeParse(value);
  if (result.success && anyIdBackfilled) {
    disambiguateSummaryIds(result.data);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

/**
 * A transition as what it does. Where it is in the file is left out.
 *
 * Adding a comment above a handler moves every offset in it and does
 * not change how it behaves. A diff that reports that move says a route
 * changed when it did not, and anybody gating a review on the diff
 * learns to ignore it.
 */
function behaviourOf(t: Transition): string {
  const { location: _location, ...behaviour } = t;
  return JSON.stringify(behaviour);
}

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
    } else if (behaviourOf(beforeT) !== behaviourOf(afterT)) {
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
