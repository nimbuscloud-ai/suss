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
  type SemanticsSchema,
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
export type Semantics = z.infer<typeof SemanticsSchema>;
export type RestSemantics = Extract<Semantics, { name: "rest" }>;
export type FunctionCallSemantics = Extract<
  Semantics,
  { name: "function-call" }
>;
export type GraphqlResolverSemantics = Extract<
  Semantics,
  { name: "graphql-resolver" }
>;
export type GraphqlOperationSemantics = Extract<
  Semantics,
  { name: "graphql-operation" }
>;
export type RuntimeConfigSemantics = Extract<
  Semantics,
  { name: "runtime-config" }
>;
export type StorageRelationalSemantics = Extract<
  Semantics,
  { name: "storage-relational" }
>;
export type MessageBusSemantics = Extract<Semantics, { name: "message-bus" }>;
export type CodeUnitIdentity = z.infer<typeof CodeUnitIdentitySchema>;

// ---------------------------------------------------------------------------
// Boundary binding constructors
// ---------------------------------------------------------------------------
//
// Keep these here (not in a pack-helpers module) so every package that
// produces a summary — pattern packs, stubs, tests — can build a
// binding without pulling in the extractor. They're the only blessed
// constructors: direct `{ transport, semantics, recognition }` literals
// are fine too but must keep the three-layer discipline.

/**
 * Build a REST-semantics binding. Every HTTP pack/stub that represents
 * a routable endpoint produces this shape. The semantics is locked to
 * `"rest"`; only the transport (usually `"http"` or `"https"`) and
 * recognition identity vary.
 *
 * `method` and `path` can be passed as empty strings to signal
 * "not yet resolved" — used by the adapter's wrapper-expansion pass
 * where the concrete path is known only at caller sites. Pairing
 * code in the checker treats empty method/path as unplaced.
 */
export function restBinding(opts: {
  transport: string;
  method: string;
  path: string;
  recognition: string;
  declaredResponses?: number[];
}): BoundaryBinding {
  return {
    transport: opts.transport,
    semantics: {
      name: "rest",
      method: opts.method.toUpperCase(),
      path: opts.path,
      ...(opts.declaredResponses !== undefined
        ? { declaredResponses: opts.declaredResponses }
        : {}),
    },
    recognition: opts.recognition,
  };
}

/**
 * Build a function-call-semantics binding. Used by in-process packs
 * (React components, custom-hook boundaries, bare TS function
 * exports). `module` and `exportName` are optional — packs that don't
 * do cross-module pairing can leave them unset.
 */
export function functionCallBinding(opts: {
  transport: string;
  recognition: string;
  module?: string;
  exportName?: string;
  package?: string;
  exportPath?: string[];
}): BoundaryBinding {
  return {
    transport: opts.transport,
    semantics: {
      name: "function-call",
      ...(opts.module !== undefined ? { module: opts.module } : {}),
      ...(opts.exportName !== undefined ? { exportName: opts.exportName } : {}),
      ...(opts.package !== undefined ? { package: opts.package } : {}),
      ...(opts.exportPath !== undefined ? { exportPath: opts.exportPath } : {}),
    },
    recognition: opts.recognition,
  };
}

/**
 * Build a function-call binding that identifies a public package
 * export — the provider side of a library boundary.
 *
 * Thin wrapper over `functionCallBinding` that keeps call sites
 * declarative: the caller states "this is a package export" rather
 * than having to remember to pass both `package` and `exportPath`.
 * Transport defaults to `"in-process"` for typical TypeScript
 * library consumption; cross-process deployments (an RPC-shim over
 * a package export) can override.
 */
export function packageExportBinding(opts: {
  transport?: string;
  recognition: string;
  packageName: string;
  exportPath: string[];
}): BoundaryBinding {
  return functionCallBinding({
    transport: opts.transport ?? "in-process",
    recognition: opts.recognition,
    package: opts.packageName,
    exportPath: opts.exportPath,
  });
}

/**
 * Build a graphql-resolver-semantics binding. Used by Apollo / AppSync /
 * yoga packs and schema-first stubs. Transport varies by deployment:
 * `"http"` for Apollo Server, `"aws-https"` for AppSync, etc.
 */
export function graphqlResolverBinding(opts: {
  transport: string;
  recognition: string;
  typeName: string;
  fieldName: string;
}): BoundaryBinding {
  return {
    transport: opts.transport,
    semantics: {
      name: "graphql-resolver",
      typeName: opts.typeName,
      fieldName: opts.fieldName,
    },
    recognition: opts.recognition,
  };
}

/**
 * Build a graphql-operation-semantics binding — the consumer side of
 * a GraphQL boundary. Anonymous operations leave `operationName` unset.
 */
export function graphqlOperationBinding(opts: {
  transport: string;
  recognition: string;
  operationType: "query" | "mutation" | "subscription";
  operationName?: string;
}): BoundaryBinding {
  return {
    transport: opts.transport,
    semantics: {
      name: "graphql-operation",
      operationType: opts.operationType,
      ...(opts.operationName !== undefined
        ? { operationName: opts.operationName }
        : {}),
    },
    recognition: opts.recognition,
  };
}

/**
 * Build a runtime-config binding — the provider side of a runtime
 * configuration channel (env vars on a Lambda / ECS task / container /
 * k8s pod). Pairs with code units that read `process.env.X` from
 * source files within the runtime's CodeUri scope.
 */
export function runtimeConfigBinding(opts: {
  recognition: string;
  deploymentTarget: "lambda" | "ecs-task" | "container" | "k8s-deployment";
  instanceName: string;
}): BoundaryBinding {
  return {
    // Runtime-config has no wire transport — env vars are handed to
    // the process by the OS at startup (regardless of the deployment
    // medium that set them). `os` reads cleanly across Lambda /
    // container / k8s, where each deployment system writes into the
    // same OS-level handoff.
    transport: "os",
    semantics: {
      name: "runtime-config",
      deploymentTarget: opts.deploymentTarget,
      instanceName: opts.instanceName,
    },
    recognition: opts.recognition,
  };
}

/**
 * Build a storage-relational binding — the provider side of a
 * relational storage table (Postgres / MySQL / SQLite). Pairs with
 * code units that emit `interaction(class: "storage-access")` effects
 * against the same `(storageSystem, scope, table)` triple.
 *
 * Other storage models (document, tabular-NoSQL, key-value, blob)
 * get their own binding constructors when those phases ship.
 */
export function storageRelationalBinding(opts: {
  recognition: string;
  storageSystem: "postgres" | "mysql" | "sqlite";
  scope: string;
  table: string;
}): BoundaryBinding {
  return {
    // Wire protocol varies (postgres-wire, mysql-wire, in-process for
    // sqlite) but pairing logic doesn't depend on it; `storageSystem`
    // on the semantics layer carries the discriminator that matters.
    // Use the storageSystem value as the transport so the layering
    // stays informative without inventing a separate wire-protocol
    // taxonomy.
    transport: opts.storageSystem,
    semantics: {
      name: "storage-relational",
      storageSystem: opts.storageSystem,
      scope: opts.scope,
      table: opts.table,
    },
    recognition: opts.recognition,
  };
}

/**
 * Build a message-bus binding — the boundary between a producer that
 * sends discrete messages and the consumer(s) that receive them.
 * Producer-side `interaction(class: "message-send")` effects pair
 * against this; consumer-side handlers gain the same shape via the
 * deployment-manifest contract source (CFN event-source mappings,
 * etc.).
 *
 * `messageBus` discriminates the implementation (`sqs`, `bullmq`,
 * `kafka`, `nats`); `channel` is the stable channel identifier
 * (CFN logical resource ID for SQS, queue/topic name for the others).
 */
export function messageBusBinding(opts: {
  recognition: string;
  messageBus: "sqs" | "bullmq" | "kafka" | "nats";
  channel: string;
}): BoundaryBinding {
  return {
    transport: opts.messageBus,
    semantics: {
      name: "message-bus",
      messageBus: opts.messageBus,
      channel: opts.channel,
    },
    recognition: opts.recognition,
  };
}

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
  library: "provider",
  client: "consumer",
  consumer: "consumer",
  caller: "consumer",
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
