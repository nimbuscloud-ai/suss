// schemas.ts — zod schemas for the behavioral summary IR.
//
// Single source of truth: the TypeScript types in `index.ts` are derived
// from these schemas via `z.infer`, and the JSON Schema published to
// `schema/behavioral-summary.schema.json` is generated from them at build
// time via `z.toJSONSchema`. Hand-edit only this file.

import { z } from "zod";

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const CodeUnitKindSchema = z.enum([
  "handler",
  "loader",
  "action",
  "component",
  "hook",
  "middleware",
  "resolver",
  "consumer",
  "client",
  "worker",
  /**
   * A function exposed through a TypeScript package's public export
   * surface — i.e. reachable from the package's `package.json` entry
   * points (`main` / `module` / `types` / `exports`). Provider side of
   * an in-process `function-call` boundary: downstream callers
   * consuming `import { fn } from "pkg"` are paired against these.
   */
  "library",
  /**
   * A function that calls into another package's public export surface
   * — the consumer side of an in-process `function-call` boundary.
   * Produced by the `packageImport` discovery variant, one unit per
   * enclosing function that invokes an imported binding. Pairs with
   * `library`-kind provider summaries by `package + exportPath`.
   */
  "caller",
]);

export const ComparisonOpSchema = z.enum([
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
]);

export const OpaqueReasonSchema = z.enum([
  "complexExpression",
  "externalFunction",
  "dynamicValue",
  "unsupportedSyntax",
]);

export const FindingKindSchema = z.enum([
  "unhandledProviderCase",
  "deadConsumerBranch",
  "providerContractViolation",
  "consumerContractViolation",
  "lowConfidence",
  /**
   * Two or more providers at the same boundary declare contracts that
   * disagree — e.g. OpenAPI spec says statuses {200, 400, 404} but the
   * CFN template's MethodResponses says {200, 400, 404, _500}. Emitted
   * by checkContractAgreement; attribution lists every contributing
   * source in `Finding.sources`.
   */
  "contractDisagreement",
  /**
   * A REST consumer call doesn't include a header the provider /
   * contract declares required (Authorization, Idempotency-Key,
   * X-API-Version, etc.). Severity: error. TypeScript only
   * catches this for typed clients that model headers in their
   * call signature; ad-hoc fetch / axios usage doesn't. Reserved
   * in v0 taxonomy; emitter ships when request-shape pairing
   * extends past status / body to headers.
   */
  "requiredHeaderMissing",
  /**
   * A REST consumer call doesn't include a query parameter the
   * provider declares required (e.g. `?cursor=X` for paginated
   * endpoints). Severity: error. Reserved in v0 taxonomy;
   * emitter ships with the same request-shape pairing extension.
   */
  "requiredQueryParamMissing",
  /**
   * A REST consumer call sends a request body whose shape
   * doesn't match the provider's declared body schema — wrong
   * field names, missing required fields, extra unknown fields.
   * Distinct from `consumerContractViolation` (which is
   * response-side); this is request-side. Severity: error.
   * Reserved in v0 taxonomy; emitter ships with body-shape
   * pairing on the request side.
   */
  "requestBodyShapeMismatch",
  /**
   * A REST consumer call targets a (method, path) combination
   * the provider doesn't expose. Today the pairing layer just
   * leaves both summaries unmatched, which silently obscures
   * what's likely a typo or stale endpoint reference.
   * Severity: error. Reserved in v0 taxonomy; emitter ships
   * when the pairing layer adds a "consumer with no provider"
   * surfaced finding distinct from "unmatched / no boundary
   * binding."
   */
  "restMethodOnUnknownPath",
  /**
   * Provider returns a content-type the consumer doesn't expect
   * (provider returns `application/xml`, consumer parses as JSON;
   * or provider returns `application/octet-stream`, consumer
   * calls `.json()`). Severity: error. Reserved in v0 taxonomy;
   * needs both sides to record content-type, which today's
   * pairing doesn't surface separately.
   */
  "contentTypeMismatch",
  /**
   * Provider requires authentication (Bearer / API key / OAuth)
   * and consumer's call doesn't send it, sends a different
   * scheme, or lacks the required scope. Severity: error.
   * Reserved in v0 taxonomy; needs auth-policy modeling on
   * both sides — the OpenAPI security schemes and the
   * client-side header / interceptor patterns. Future work.
   */
  "authPolicyMismatch",
  /**
   * A declared-scenario source (Storybook story, fixture, example
   * payload) references a prop / arg the target unit doesn't declare
   * as an input. Almost always means the scenario is outdated — the
   * component removed or renamed a prop but the scenario wasn't
   * updated. Emitted by the component/story agreement check.
   */
  "scenarioArgUnknown",
  /**
   * A component has a conditional branch that depends on a prop,
   * and no declared scenario (Storybook story, fixture, etc.)
   * exercises that branch. Emitted by the component/story
   * agreement check — a genuine behavioral gap: the component
   * has logic that no story tests, so changes to that branch
   * can regress silently.
   */
  "scenarioCoverageGap",
  /**
   * A scenario doesn't supply a prop the component declares
   * required. Severity: error. Distinct from `scenarioArgUnknown`
   * (story passes a prop the component doesn't accept) — this
   * is the inverse: the component requires it; the story omits
   * it. Reserved in v0 taxonomy; emitter waits for the
   * component-input pack to surface required-vs-optional on
   * declared inputs (today the React adapter records inputs
   * but not their required-ness).
   */
  "componentRequiredPropMissing",
  /**
   * A scenario passes a value of the wrong type for a prop —
   * e.g. story `args: { count: "5" }` when the component
   * declares `count: number`. Severity: error. TypeScript
   * catches this when the story uses `Meta<typeof Component>`;
   * misses for hand-written stories that escape the typing or
   * pass `as any`. Reserved in v0 taxonomy.
   */
  "componentPropTypeMismatch",
  /**
   * A GraphQL consumer operation selects a root-level field
   * (Query.*, Mutation.*, Subscription.*) that no provider
   * resolver implements. Emitted by the operation→resolver
   * pairing pass when an operation touches a field for which
   * no `graphql-resolver(typeName, fieldName)` summary exists
   * in the visible set. A strong signal the consumer is out
   * of sync with the deployed schema — either the operation
   * got stale or the resolver was removed.
   */
  "graphqlFieldNotImplemented",
  /**
   * A GraphQL consumer operation selects a nested field on an
   * object type that the provider's schema doesn't declare.
   * Example: operation selects `pet { deletedAt }` but the
   * schema's `Pet` type has no `deletedAt` field. Emitted by
   * the nested-selection pass when the provider's
   * `metadata.graphql.schemaSdl` surfaces a type whose field
   * set excludes the consumer's selection.
   */
  "graphqlSelectionFieldUnknown",
  /**
   * A GraphQL consumer operation declares a variable type that
   * doesn't match the resolver's argument type. Example:
   * operation `query GetUser($id: String!)` but the schema's
   * `user(id: ID!)` expects `ID!`. Severity: error — at
   * runtime the resolver receives a type-coerced value or
   * outright fails. Reserved in v0 taxonomy; emitter ships
   * with the GraphQL operation→resolver pairing extension
   * (today the pass only checks field existence).
   */
  "graphqlVariableTypeMismatch",
  /**
   * A GraphQL consumer operation calls a field with positional
   * args missing one or more required arguments declared by
   * the schema. Example: operation `user(id: $id)` but the
   * schema's `user(id: ID!, version: Int!)` requires `version`.
   * Severity: error. Reserved in v0 taxonomy; emitter ships
   * with the same operation→resolver pairing extension.
   */
  "graphqlRequiredArgMissing",
  /**
   * A GraphQL consumer operation passes an enum value the
   * schema's enum declaration doesn't include. Example:
   * `status: PENDING_REVIEW` but the schema's `Status` enum is
   * `{PENDING, APPROVED, REJECTED}`. Severity: error. Reserved
   * in v0 taxonomy; typed clients (codegen) catch this at
   * compile time, so the emitter waits for cases where the
   * value escapes typing or comes from a literal-string client.
   */
  "graphqlEnumValueUnknown",
  /**
   * Code reads `process.env.X` from a source file scoped to a
   * deployable runtime instance, but that runtime's declared
   * env-var contract doesn't include `X`. Emitted by
   * checkRuntimeConfig — the dominant cause is a typo or a
   * declaration omission between the code and the
   * infrastructure template (CFN/SAM/k8s manifest). Severity is
   * error: at deploy time this surfaces as a runtime undefined.
   */
  "envVarUnprovided",
  /**
   * A deployable runtime instance declares an env var that no
   * code in its codeScope reads. Emitted by checkRuntimeConfig
   * — usually dead config left over from a removed feature, or
   * a renamed var the template still references. Severity is
   * warning: the deployment still works, but the contract has
   * stale fields the consumer ignored.
   */
  "envVarUnused",
  /**
   * A runtime-config-bound provider summary declares no
   * codeScope (or one we couldn't resolve to source files), so
   * we can't pair its env-var contract against any code.
   * Emitted by checkRuntimeConfig as info — a heads-up that
   * verification was skipped, not a defect in the code itself.
   * Common cause: raw CloudFormation that uses S3-built
   * artifacts (no `CodeUri`) without a `Metadata.SussCodeScope`
   * annotation.
   */
  "runtimeScopeUnknown",
  /**
   * Code treats `process.env.X` as definitely-required (e.g.
   * `if (!process.env.X) throw …` or unconditional read), but
   * the runtime contract doesn't mark it as required (no
   * deployment-side validation, no documented requirement).
   * Severity: warning. Reserved in v0 taxonomy; emitter waits
   * for the runtime stub to grow a "required" attribute on
   * env-var entries (currently the contract is just the name
   * list).
   */
  "envVarRequiredButUnmarked",
  /**
   * Code reads an env var as if it were a non-string type
   * (`process.env.PORT` used as a number without `Number(...)`
   * / `parseInt`; `process.env.FLAG` used as a boolean without
   * comparison) without the coercion the runtime contract
   * implies. Env vars are always strings at the OS interface;
   * code that forgets that flips truthy checks ("0" is truthy)
   * and produces silent type errors. Severity: warning.
   * Reserved in v0 taxonomy.
   */
  "envVarTypeCoercionMissing",
  /**
   * Code reads a column the schema doesn't declare. Most often a
   * typo (`deltedAt` instead of `deletedAt`) or stale code that
   * still references a renamed column. Severity: error — at
   * runtime this resolves to undefined and silently flips truthy
   * checks downstream. Emitted by checkRelationalStorage.
   */
  "storageReadFieldUnknown",
  /**
   * Code writes a column the schema doesn't declare. Same family
   * as storageReadFieldUnknown but on the write side; the row
   * gets inserted/updated without the field — silent data loss.
   * Severity: error.
   */
  "storageWriteFieldUnknown",
  /**
   * Schema declares a column that no code in the project reads
   * or writes. Usually dead config left over from a removed
   * feature, or a renamed column the schema still has. Severity:
   * warning — the column still exists in the database but
   * nothing exercises it. Suppressed when ANY caller uses
   * default-shape (`["*"]`) reads on the table, since we can't
   * tell whether default-shape consumers actually use the column.
   */
  "storageFieldUnused",
  /**
   * A column that code writes but no code ever reads. Likely
   * useless data — the application stores values nothing
   * downstream consumes. Severity: warning. Could indicate dead
   * code, an in-progress feature, or a column that should be
   * dropped.
   */
  "storageWriteOnlyField",
  /**
   * A `findUnique`-style selector references a column set that
   * isn't a unique index on the table. At runtime the call
   * fails (Prisma / typed ORMs reject at the type level; raw
   * SQL drivers and Drizzle compile but the query returns
   * non-deterministic single rows). Severity: error. Pairs the
   * `selector` field on a `storageAccess` effect against the
   * `indexes` declared on the provider's `storageContract`.
   *
   * Reserved in v0 taxonomy; emitter ships when an access pack
   * needs it (likely in the Drizzle / raw-SQL packs where
   * TypeScript doesn't catch the case at compile time).
   */
  "storageSelectorIndexMismatch",
  /**
   * Code writes a value of one type to a column of an
   * incompatible type (string to Int, number to text, etc.).
   * Severity: error. Reserved in v0 taxonomy; typed ORMs
   * (Prisma, Drizzle) generally catch this at the TypeScript
   * level so the emitter waits for a raw-SQL pack or a value
   * that escapes the type system via `any`.
   */
  "storageTypeMismatch",
  /**
   * Code writes `null` to a `NOT NULL` column, or treats the
   * value of a nullable column as definitely-non-null without
   * a guard. Severity: error. Reserved in v0 taxonomy; typed
   * ORMs cover the common case via generated types, so the
   * emitter waits for a raw-SQL pack or escape-hatch detection.
   */
  "storageNullableViolation",
  /**
   * Code writes a string literal longer than the column's
   * declared length (`varchar(50)` written with 200+ chars).
   * Severity: error. Reserved in v0 taxonomy; requires both the
   * literal length and the column constraint to be statically
   * known. Useful even with typed ORMs since TypeScript doesn't
   * model string lengths.
   */
  "storageLengthConstraintViolation",
  /**
   * Code writes a value that isn't in the column's declared
   * enum set. Severity: error. Reserved in v0 taxonomy; typed
   * ORMs catch this at the TS level when the value is a typed
   * enum literal, so the emitter waits for cases where the
   * value escapes the type system or comes from a raw-SQL pack.
   */
  "storageEnumConstraintViolation",
  /**
   * A pack identifies a boundary it doesn't know how to
   * summarise — a WebSocket subscription handler, an SSE stream
   * producer, a gRPC streaming method, etc. Severity: info. The
   * pack should still emit a stub-shaped summary marking the
   * boundary's existence; this finding alerts users that the
   * extracted summary won't pair against consumers because the
   * semantics aren't modelled. Reserved in v0 taxonomy; emitter
   * ships when a pack first encounters a boundary it can't
   * fully describe.
   */
  "unsupportedSemantics",
  /**
   * A pairing pass refused to emit substantive findings because
   * too many predicates on the relevant transitions are opaque
   * (the extractor couldn't decompose them; preconditions /
   * branches show as raw source text). Severity: info. Distinct
   * from `lowConfidence`, which is per-summary; this is per-pair
   * — pairing produced no signal because the inputs were too
   * murky to reason over. Reserved in v0 taxonomy; emitter
   * ships when a pairing pass adds an explicit "I bailed"
   * disclosure.
   */
  "opaquePredicateBlocking",
]);

export const FindingSeveritySchema = z.enum(["error", "warning", "info"]);

export const ConfidenceSourceSchema = z.enum([
  "inferred_static",
  "inferred_ai",
  "declared",
  "derived",
]);

export const ConfidenceLevelSchema = z.enum(["high", "medium", "low"]);

// ---------------------------------------------------------------------------
// Leaf object schemas
// ---------------------------------------------------------------------------

export const SourceLocationSchema = z.object({
  file: z.string(),
  range: z.object({ start: z.number(), end: z.number() }),
  exportName: z.string().nullable(),
});

// ---------------------------------------------------------------------------
// Boundary binding — three-layer model (see docs/boundary-semantics.md)
// ---------------------------------------------------------------------------
//
// `transport` is the wire/carrier (http, in-process, aws-https, etc).
// `semantics` is the discriminated union the checker dispatches on — what
//  the participants think they're doing (REST resource, in-process function
//  call, GraphQL operation when that lands).
// `recognition` is the pack identity that produced this binding ("ts-rest",
//  "react", "openapi-stub", …) — used for provenance and pack-level dedupe,
//  not for pairing or discriminator dispatch.

export const RestSemanticsSchema = z.object({
  name: z.literal("rest"),
  /** Uppercase HTTP method ("GET", "POST", …). */
  method: z.string(),
  /** Normalized route path ("/users/{id}"). */
  path: z.string(),
  /**
   * Status codes the producing source explicitly declared (OpenAPI
   * responses, CFN MethodResponses, ts-rest router statuses). Kept here
   * so the pairing layer can still see them without unwrapping metadata.
   * Empty / absent for inferred sources.
   */
  declaredResponses: z.array(z.number()).optional(),
});

export const FunctionCallSemanticsSchema = z.object({
  name: z.literal("function-call"),
  /**
   * Optional module identifier for cross-unit references
   * (e.g. `"./components/Button"` for a React component, or the TS
   * module path for a bare function export). Packs that don't do
   * cross-module pairing can leave it unset.
   */
  module: z.string().optional(),
  /** Named export within the module, when applicable. */
  exportName: z.string().optional(),
  /**
   * Package name (as written in `package.json`) when this identity
   * refers to a public package export — e.g. `"@suss/behavioral-ir"`.
   * Set alongside `exportPath` by packs that resolve a package's
   * public surface (the `packageExports` discovery variant). Distinct
   * from `module`, which is a repo-relative module path for
   * intra-repo pairing.
   */
  package: z.string().optional(),
  /**
   * Path to the exported binding within the package, starting with
   * the sub-path key when one is used. Examples:
   *   `["parseSummary"]`              — root export
   *   `["schemas", "BoundaryBindingSchema"]` — sub-path `./schemas`
   *
   * The first segment is the sub-path without the leading `./`
   * (`"."` → omitted). The last segment is the exported name.
   * Intermediate segments correspond to nested re-export structure
   * when a pack records it; most v0 packs use one-or-two-segment
   * paths.
   */
  exportPath: z.array(z.string()).optional(),
});

/**
 * Provider-side GraphQL resolver. One resolver binds one
 * (typeName, fieldName) pair. Discrimination at the resolver level
 * rather than field level — each resolver function is the smallest
 * independently-schedulable unit, and partial-null / per-field error
 * behavior is a property of the resolver, not the surrounding type.
 *
 * Pairing key: `${typeName}.${fieldName}`. Transport-agnostic —
 * resolvers run under Apollo Server (HTTP), AppSync (aws-https /
 * AppSync integration), yoga, or stitched gateways alike.
 */
export const GraphqlResolverSemanticsSchema = z.object({
  name: z.literal("graphql-resolver"),
  /** GraphQL type the resolver attaches to: "Query", "Mutation", "Subscription", or an object-type name like "User". */
  typeName: z.string(),
  /** Field name on that type. */
  fieldName: z.string(),
});

/**
 * Consumer-side GraphQL operation — a document sent from client to
 * server. Binds to an operation by name + operation type. Pairs with
 * the matching resolver(s) at runtime; checking is more involved
 * than REST pairing (one operation can touch many resolvers via
 * selection set), and is deferred until the consumer-side pack lands.
 */
export const GraphqlOperationSemanticsSchema = z.object({
  name: z.literal("graphql-operation"),
  /** Optional operation name — anonymous queries / mutations leave this unset. */
  operationName: z.string().optional(),
  operationType: z.enum(["query", "mutation", "subscription"]),
});

/**
 * Provider-side runtime configuration channel — env vars + their
 * declared values on a deployable unit (Lambda, ECS task, container,
 * k8s pod). The channel is the boundary; env var names are FIELDS on
 * its contract (analogous to `body.email` being a field on a REST
 * endpoint's contract). Pairing key: `(deploymentTarget, instanceName)`.
 * The list of env vars provided lives in `metadata.runtimeContract.envVars`
 * on the summary; `metadata.codeScope` declares which source files
 * run inside the channel so the pairing layer can scope code reads.
 */
export const RuntimeConfigSemanticsSchema = z.object({
  name: z.literal("runtime-config"),
  deploymentTarget: z.enum([
    "lambda",
    "ecs-task",
    "container",
    "k8s-deployment",
  ]),
  /**
   * Stable identifier for the runtime instance — CFN logical resource
   * ID for Lambda / ECS, k8s deployment name, container name. Pairs
   * across runs; survives template rename only when the underlying
   * physical name does.
   */
  instanceName: z.string(),
});

/**
 * Provider-side relational storage table — Postgres / MySQL / SQLite
 * declared via Prisma `model`, Drizzle `pgTable(...)`, TypeORM
 * `@Entity`, or raw SQL DDL. Columns are FIELDS on the table's
 * contract; field-level access checks compare what code reads/writes
 * against `metadata.storageContract.columns`. Pairing key:
 * `(storageSystem, scope, table)`.
 *
 * Other storage models (document, tabular-NoSQL, key-value, blob)
 * each get their own SemanticsSchema variant when those phases ship
 * — see `docs/internal/storage-pairing.md`.
 */
export const StorageRelationalSemanticsSchema = z.object({
  name: z.literal("storage-relational"),
  storageSystem: z.enum(["postgres", "mysql", "sqlite"]),
  /**
   * ORM / driver scope. Defaults to `"default"` for single-database
   * setups; monorepos with multiple Prisma schemas or multiple
   * connection pools use distinct values to keep pairings separate.
   */
  scope: z.string(),
  /** Table / model name as declared in the schema. */
  table: z.string(),
});

export const SemanticsSchema = z.discriminatedUnion("name", [
  RestSemanticsSchema,
  FunctionCallSemanticsSchema,
  GraphqlResolverSemanticsSchema,
  GraphqlOperationSemanticsSchema,
  RuntimeConfigSemanticsSchema,
  StorageRelationalSemanticsSchema,
]);

export const BoundaryBindingSchema = z.object({
  transport: z.string(),
  semantics: SemanticsSchema,
  recognition: z.string(),
});

export const CodeUnitIdentitySchema = z.object({
  name: z.string(),
  exportPath: z.array(z.string()).nullable(),
  boundaryBinding: BoundaryBindingSchema.nullable(),
});

export const ConfidenceInfoSchema = z.object({
  source: ConfidenceSourceSchema,
  level: ConfidenceLevelSchema,
});

export const LiteralSchema = z.object({
  type: z.literal("literal"),
  value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
});

export const DerivationSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("propertyAccess"), property: z.string() }),
  z.object({
    type: z.literal("methodCall"),
    method: z.string(),
    args: z.array(z.string()),
  }),
  z.object({ type: z.literal("destructured"), field: z.string() }),
  z.object({ type: z.literal("awaited") }),
  z.object({
    type: z.literal("indexAccess"),
    index: z.union([z.string(), z.number()]),
  }),
]);

// ---------------------------------------------------------------------------
// Recursive shapes — ValueRef, Predicate, TypeShape
// ---------------------------------------------------------------------------
//
// zod v4 handles recursion via `z.lazy()` with an explicit type annotation.
// The recursive structures below cross-reference each other (Predicate
// contains ValueRef; TypeShape contains TypeShape; Output contains
// ValueRef and TypeShape).

export interface ValueRef {
  type: "input" | "dependency" | "derived" | "literal" | "state" | "unresolved";
}

export interface Derivation {
  type:
    | "propertyAccess"
    | "methodCall"
    | "destructured"
    | "awaited"
    | "indexAccess";
}

// Forward type declarations for recursive schemas. The zod schemas below
// produce types compatible with these.
type ValueRefT =
  | { type: "input"; inputRef: string; path: string[] }
  | { type: "dependency"; name: string; accessChain: string[] }
  | {
      type: "derived";
      from: ValueRefT;
      derivation: z.infer<typeof DerivationSchema>;
    }
  | { type: "literal"; value: string | number | boolean | null }
  | { type: "state"; name: string }
  | { type: "unresolved"; sourceText: string };

export const ValueRefSchema: z.ZodType<ValueRefT> = z.lazy(() =>
  z.discriminatedUnion("type", [
    z.object({
      type: z.literal("input"),
      inputRef: z.string(),
      path: z.array(z.string()),
    }),
    z.object({
      type: z.literal("dependency"),
      name: z.string(),
      accessChain: z.array(z.string()),
    }),
    z.object({
      type: z.literal("derived"),
      from: ValueRefSchema,
      derivation: DerivationSchema,
    }),
    LiteralSchema,
    z.object({ type: z.literal("state"), name: z.string() }),
    z.object({ type: z.literal("unresolved"), sourceText: z.string() }),
  ]),
);

type PredicateT =
  | { type: "nullCheck"; subject: ValueRefT; negated: boolean }
  | { type: "truthinessCheck"; subject: ValueRefT; negated: boolean }
  | {
      type: "comparison";
      left: ValueRefT;
      op: z.infer<typeof ComparisonOpSchema>;
      right: ValueRefT;
    }
  | { type: "typeCheck"; subject: ValueRefT; expectedType: string }
  | {
      type: "propertyExists";
      subject: ValueRefT;
      property: string;
      negated: boolean;
    }
  | { type: "compound"; op: "and" | "or"; operands: PredicateT[] }
  | { type: "negation"; operand: PredicateT }
  | { type: "call"; callee: string; args: ValueRefT[] }
  | {
      type: "opaque";
      sourceText: string;
      reason: z.infer<typeof OpaqueReasonSchema>;
    };

export const PredicateSchema: z.ZodType<PredicateT> = z.lazy(() =>
  z.discriminatedUnion("type", [
    z.object({
      type: z.literal("nullCheck"),
      subject: ValueRefSchema,
      negated: z.boolean(),
    }),
    z.object({
      type: z.literal("truthinessCheck"),
      subject: ValueRefSchema,
      negated: z.boolean(),
    }),
    z.object({
      type: z.literal("comparison"),
      left: ValueRefSchema,
      op: ComparisonOpSchema,
      right: ValueRefSchema,
    }),
    z.object({
      type: z.literal("typeCheck"),
      subject: ValueRefSchema,
      expectedType: z.string(),
    }),
    z.object({
      type: z.literal("propertyExists"),
      subject: ValueRefSchema,
      property: z.string(),
      negated: z.boolean(),
    }),
    z.object({
      type: z.literal("compound"),
      op: z.enum(["and", "or"]),
      operands: z.array(PredicateSchema),
    }),
    z.object({ type: z.literal("negation"), operand: PredicateSchema }),
    z.object({
      type: z.literal("call"),
      callee: z.string(),
      args: z.array(ValueRefSchema),
    }),
    z.object({
      type: z.literal("opaque"),
      sourceText: z.string(),
      reason: OpaqueReasonSchema,
    }),
  ]),
);

type TypeShapeT =
  | {
      type: "record";
      properties: Record<string, TypeShapeT>;
      spreads?: Array<{ sourceText: string }> | undefined;
    }
  | { type: "dictionary"; values: TypeShapeT }
  | { type: "array"; items: TypeShapeT }
  | {
      type: "literal";
      value: string | number | boolean;
      raw?: string | undefined;
    }
  | { type: "text" }
  | { type: "integer" }
  | { type: "number" }
  | { type: "boolean" }
  | { type: "null" }
  | { type: "undefined" }
  | { type: "union"; variants: TypeShapeT[] }
  | { type: "ref"; name: string }
  | { type: "unknown" };

export const TypeShapeSchema: z.ZodType<TypeShapeT> = z.lazy(() =>
  z.discriminatedUnion("type", [
    z.object({
      type: z.literal("record"),
      properties: z.record(z.string(), TypeShapeSchema),
      spreads: z.array(z.object({ sourceText: z.string() })).optional(),
    }),
    z.object({ type: z.literal("dictionary"), values: TypeShapeSchema }),
    z.object({ type: z.literal("array"), items: TypeShapeSchema }),
    z.object({
      type: z.literal("literal"),
      value: z.union([z.string(), z.number(), z.boolean()]),
      raw: z.string().optional(),
    }),
    z.object({ type: z.literal("text") }),
    z.object({ type: z.literal("integer") }),
    z.object({ type: z.literal("number") }),
    z.object({ type: z.literal("boolean") }),
    z.object({ type: z.literal("null") }),
    z.object({ type: z.literal("undefined") }),
    z.object({
      type: z.literal("union"),
      variants: z.array(TypeShapeSchema),
    }),
    z.object({ type: z.literal("ref"), name: z.string() }),
    z.object({ type: z.literal("unknown") }),
  ]),
);

// ---------------------------------------------------------------------------
// Render tree — component-style output (React JSX, Vue templates, etc.)
// ---------------------------------------------------------------------------

type RenderNodeT =
  | {
      type: "element";
      tag: string;
      /**
       * Raw JSX attributes on the opening element, keyed by name and
       * mapped to the *source text* of the attribute's value. String-
       * literal attributes include their surrounding quotes (`type="button"`
       * → `"\"button\""`); expression-valued attributes include the full
       * expression (`onClick` → `"() => setCount(count + 1)"`); boolean
       * shorthand attributes (`<input disabled>`) map to the empty
       * string. No interpretation happens here — consumers that care
       * about event semantics (React's `onX` convention, Storybook's
       * `play` function targets) apply their own naming rules to
       * resolve handler summary identities. Omitted when the element
       * has no attributes (keeps tree output terse for text-heavy
       * templates).
       */
      attrs?: Record<string, string> | undefined;
      children: RenderNodeT[];
    }
  | { type: "text"; value: string }
  | { type: "expression"; sourceText: string }
  | {
      // Inline JSX conditionals: `{cond && <X/>}`, `{cond ? <A/> : <B/>}`,
      // `{cond ? <A/> : null}`. The `condition` carries the test
      // expression's source text verbatim — downstream consumers that
      // want a structured predicate can re-parse it, but preserving the
      // text means the summary stays legible without binding to the
      // current predicate decomposer.
      //
      // `whenTrue` is the branch rendered when the condition is truthy.
      // `whenFalse` is the branch rendered when falsy; null means the
      // conditional has no else (the `cond && <X/>` case) or the else
      // is explicitly `null` in source. Both alternatives render
      // nothing when absent — React treats `null`, `false`, and
      // `undefined` children as empty. Deliberately avoiding `then` /
      // `else` to sidestep the thenable-lookalike footgun: any object
      // with a `then` property can trip loose duck-typing checks in
      // older libraries, and the ESTree `consequent` / `alternate`
      // vocabulary needs parser-author context to read.
      type: "conditional";
      condition: string;
      whenTrue: RenderNodeT;
      whenFalse: RenderNodeT | null;
    };

export const RenderNodeSchema: z.ZodType<RenderNodeT> = z.lazy(() =>
  z.discriminatedUnion("type", [
    z.object({
      type: z.literal("element"),
      tag: z.string(),
      attrs: z.record(z.string(), z.string()).optional(),
      children: z.array(RenderNodeSchema),
    }),
    z.object({ type: z.literal("text"), value: z.string() }),
    z.object({ type: z.literal("expression"), sourceText: z.string() }),
    z.object({
      type: z.literal("conditional"),
      condition: z.string(),
      whenTrue: RenderNodeSchema,
      whenFalse: RenderNodeSchema.nullable(),
    }),
  ]),
);

// ---------------------------------------------------------------------------
// Inputs, Outputs, Effects
// ---------------------------------------------------------------------------

export const InputSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("parameter"),
    name: z.string(),
    position: z.number(),
    role: z.string(),
    shape: TypeShapeSchema.nullable(),
  }),
  z.object({
    type: z.literal("injection"),
    name: z.string(),
    mechanism: z.string(),
    shape: TypeShapeSchema.nullable(),
  }),
  z.object({
    type: z.literal("hookReturn"),
    hook: z.string(),
    destructuredFields: z.array(z.string()),
  }),
  z.object({
    type: z.literal("contextValue"),
    context: z.string(),
    accessedFields: z.array(z.string()),
  }),
  z.object({ type: z.literal("closure"), name: z.string() }),
]);

export const OutputSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("response"),
    statusCode: ValueRefSchema.nullable(),
    body: TypeShapeSchema.nullable(),
    headers: z.record(z.string(), ValueRefSchema),
  }),
  z.object({
    type: z.literal("throw"),
    exceptionType: z.string().nullable(),
    message: z.string().nullable(),
  }),
  z.object({
    type: z.literal("render"),
    component: z.string(),
    props: z.record(z.string(), z.unknown()).optional(),
    /**
     * Optional full rendered-tree shape. Packs that understand their
     * source language's render form (JSX, Vue templates, Svelte
     * markup) populate this so cross-boundary checking can compare
     * structural output against stubbed contracts (snapshots,
     * Storybook stories, Figma variants). Consumers that only care
     * about the root element read `component`; those that want the
     * full tree read `root`.
     */
    root: RenderNodeSchema.optional(),
  }),
  z.object({
    type: z.literal("return"),
    value: TypeShapeSchema.nullable(),
  }),
  z.object({ type: z.literal("delegate"), to: z.string() }),
  z.object({
    type: z.literal("emit"),
    event: z.string(),
    payload: TypeShapeSchema.optional(),
  }),
  z.object({ type: z.literal("void") }),
]);

export const EffectSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("mutation"),
    target: z.string(),
    operation: z.enum(["create", "update", "delete"]),
  }),
  z.object({
    type: z.literal("invocation"),
    callee: z.string(),
    args: z.array(z.unknown()),
    async: z.boolean(),
    /**
     * Ancestor conditions that gate reaching this call within its
     * enclosing transition — populated for calls nested inside
     * conditional blocks (`if (result === "nomatch") findings.push(...)`)
     * or loop bodies. Absent for unconditional, always-fires calls.
     * Same shape as Transition.conditions: opaque fallback when the
     * source condition couldn't be decomposed structurally.
     */
    preconditions: z.array(PredicateSchema).optional(),
  }),
  z.object({
    type: z.literal("emission"),
    event: z.string(),
    payload: z.unknown().optional(),
  }),
  z.object({
    type: z.literal("stateChange"),
    variable: z.string(),
    newValue: z.unknown().optional(),
  }),
  /**
   * Read or write against a storage system (Postgres / MySQL / SQLite
   * via Prisma, Drizzle, raw drivers, etc.). Captured as a transition
   * effect so storage accesses get the same execution-path attribution
   * invocation effects already have — preconditions for branched
   * calls, location for the call site. One transition can have
   * MULTIPLE storageAccess effects (a join or nested select touches
   * more than one table). The pairing layer
   * (`checkRelationalStorage`) groups these by `(storageSystem,
   * scope, table)` and compares field sets against schema-derived
   * provider summaries.
   */
  z.object({
    type: z.literal("storageAccess"),
    kind: z.enum(["read", "write"]),
    /** Matches the `storageSystem` on the paired storage-* binding. */
    storageSystem: z.string(),
    /** ORM / driver scope (defaults to "default" for single-DB setups). */
    scope: z.string(),
    /** Table / model the access targets. */
    table: z.string(),
    /**
     * Columns referenced by the access. `["*"]` is the convention for
     * default-shape reads (e.g. Prisma `findUnique({ where: { id } })`
     * with no `select`) — the consumer reads every scalar column the
     * provider declares. Pairing logic treats `["*"]` specially when
     * deciding whether a column is unused.
     */
    fields: z.array(z.string()),
    /**
     * For reads: columns referenced in the where-clause / selector
     * (Prisma `where`, Drizzle `.where(eq(table.col, x))`, raw
     * `WHERE col = ?`). Used by future checks that pair selector
     * columns against indexes; ignored for write-side checks today.
     */
    selector: z.array(z.string()).optional(),
    /**
     * The driver-specific operation name — `findUnique`, `create`,
     * `select`, `insertOne`, etc. Informational; the kind field is
     * what pairing dispatches on.
     */
    operation: z.string().optional(),
    /**
     * Same shape as invocation.preconditions — the ancestor conditions
     * that gate reaching this access within its transition. Populated
     * for accesses nested inside conditional blocks.
     */
    preconditions: z.array(PredicateSchema).optional(),
  }),
]);

// ---------------------------------------------------------------------------
// Transition, Gap, BehavioralSummary
// ---------------------------------------------------------------------------

export const TransitionSchema = z.object({
  id: z.string(),
  conditions: z.array(PredicateSchema),
  output: OutputSchema,
  effects: z.array(EffectSchema),
  location: z.object({ start: z.number(), end: z.number() }),
  isDefault: z.boolean(),
  confidence: ConfidenceInfoSchema.optional(),
  expectedInput: TypeShapeSchema.optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const GapSchema = z.object({
  type: z.literal("unhandledCase"),
  conditions: z.array(PredicateSchema),
  consequence: z.enum([
    "frameworkDefault",
    "implicitThrow",
    "fallthrough",
    "unknown",
  ]),
  description: z.string(),
});

export const BehavioralSummarySchema = z.object({
  kind: CodeUnitKindSchema,
  location: SourceLocationSchema,
  identity: CodeUnitIdentitySchema,
  inputs: z.array(InputSchema),
  transitions: z.array(TransitionSchema),
  gaps: z.array(GapSchema),
  confidence: ConfidenceInfoSchema,
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const BehavioralSummaryArraySchema = z.array(BehavioralSummarySchema);

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

export const FindingSideSchema = z.object({
  summary: z.string(),
  transitionId: z.string().optional(),
  location: SourceLocationSchema,
});

export const FindingSuppressionSchema = z.object({
  /** Human-written explanation from the .sussignore rule. Required. */
  reason: z.string(),
  /**
   * What happened to this finding:
   *   - "mark": still shown and returned; excluded from exit-code
   *     threshold calculations. Default.
   *   - "downgrade": severity dropped one level (error -> warning ->
   *     info); still counted toward exit code at the downgraded level.
   *   - "hide": filtered from output and exit code entirely. The
   *     `suppressed` annotation survives only for downstream JSON
   *     consumers that want to see what was silenced.
   */
  effect: z.enum(["mark", "downgrade", "hide"]),
  /**
   * Original severity before downgrade, preserved so downstream tools
   * can distinguish "this was always info" from "this was downgraded
   * from error to info." Present only when effect is "downgrade".
   */
  originalSeverity: FindingSeveritySchema.optional(),
});

export const FindingSchema = z.object({
  kind: FindingKindSchema,
  boundary: BoundaryBindingSchema,
  provider: FindingSideSchema,
  consumer: FindingSideSchema,
  description: z.string(),
  severity: FindingSeveritySchema,
  /**
   * Present only when two or more identical findings (same kind,
   * boundary, description, consumer) from different providers were
   * collapsed by the checker's dedup pass. Each entry is a
   * `${file}::${name}` identifier matching FindingSide.summary.
   * Single-source findings leave this unset. The `provider` field
   * above still points at one representative contributor.
   */
  sources: z.array(z.string()).optional(),
  /**
   * Present only when a .sussignore rule matched this finding. The
   * `effect` tells downstream tools how the finding was handled;
   * `reason` is the rule's human-written justification.
   */
  suppressed: FindingSuppressionSchema.optional(),
});

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

export const SummaryDiffSchema = z.object({
  addedTransitions: z.array(TransitionSchema),
  removedTransitions: z.array(TransitionSchema),
  changedTransitions: z.array(
    z.object({ before: TransitionSchema, after: TransitionSchema }),
  ),
});
